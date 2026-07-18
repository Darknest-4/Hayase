// WSOLA-based time-stretching adapted from Vanilagy's gist:
// https://gist.github.com/Vanilagy/05f7901f4c4398356657e3a86c7aee05

registerProcessor('audio-stream-processor', class AudioStreamProcessor extends AudioWorkletProcessor {
  _chunks: Array<{ channelData: Float32Array[], length: number }> = []
  _offset = 0
  _inputConsumed = 0
  _step = 1
  _frameSize = 1024
  _hop = 512
  _tolerance = 512
  _hann: Float32Array
  _hannInv: Float32Array
  _hasDoneOutput = false
  _outBuf: Float32Array[] = []
  _outPos = 0
  _outEnd = 0

  constructor () {
    super()
    this._hann = new Float32Array(this._hop)
    this._hannInv = new Float32Array(this._hop)
    for (let i = 0; i < this._hop; i++) {
      const v = 0.5 * (1 - Math.cos(Math.PI * i / this._hop))
      this._hann[i] = v
      this._hannInv[i] = 1 - v
    }
    this.port.onmessage = ({ data }) => {
      if (data.type === 'push') {
        this._chunks.push({ channelData: data.channelData, length: data.channelData[0].length })
      } else if (data.type === 'flush') {
        this._chunks = []
        this._offset = 0
        this._inputConsumed = 0
        this._outBuf = []
        this._outPos = 0
        this._outEnd = 0
        this._hasDoneOutput = false
      } else if (data.type === 'rate') {
        this._step = Math.max(0.01, data.playbackRate)
        if (this._step !== 1) {
          this._outBuf = []
          this._outPos = 0
          this._outEnd = 0
          this._hasDoneOutput = false
        }
        this.port.postMessage({ type: 'progress', samplesConsumed: this._inputConsumed })
      }
    }
  }

  _readFrame (size: number, atOffset?: number): Float32Array[] | null {
    if (this._chunks.length === 0) return null
    const idx = Math.max(0, Math.round(atOffset ?? this._offset))
    let skip = idx
    let ci = 0
    while (ci < this._chunks.length && skip >= this._chunks[ci]!.length) {
      skip -= this._chunks[ci]!.length
      ci++
    }
    if (ci >= this._chunks.length) return null

    const frame: Float32Array[] = []
    for (let c = 0; c < this._chunks[ci]!.channelData.length; c++) {
      frame.push(new Float32Array(size))
    }
    for (let c = 0; c < frame.length; c++) {
      let dst = 0
      let ci2 = ci
      let pos = skip
      while (dst < size && ci2 < this._chunks.length) {
        const ch = this._chunks[ci2]!
        const src = ch.channelData[c] ?? ch.channelData[0]!
        const take = Math.min(ch.length - pos, size - dst)
        frame[c]!.set(src.subarray(pos, pos + take), dst)
        dst += take
        pos += take
        if (pos >= ch.length) { pos = 0; ci2++ }
      }
    }
    return frame
  }

  _processWSOLA (blockSize: number): Float32Array[] | null {
    const numCh = this._outBuf.length || (this._chunks[0]?.channelData.length ?? 2)
    if (this._outBuf.length === 0) {
      for (let c = 0; c < numCh; c++) this._outBuf[c] = new Float32Array(16384)
    }

    while (this._outPos < blockSize) {
      const center = Math.round(this._offset)
      const readStart = Math.max(0, center - this._tolerance)
      const searchSize = 2 * this._tolerance + this._frameSize
      const searchBuf = this._readFrame(searchSize, readStart)
      if (!searchBuf) break

      const centerInBuf = center - readStart
      const outBuf = this._outBuf
      const hop = this._hop
      const outPos = this._outPos
      const hann = this._hann
      const hannInv = this._hannInv

      // Pre-extract channels, avoiding ?? in inner loops
      const oldChs: Float32Array[] = []
      const searchChs: Float32Array[] = []
      for (let c = 0; c < numCh; c++) {
        oldChs[c] = outBuf[c]!
        searchChs[c] = searchBuf[c] ?? searchBuf[0]!
      }

      // WSOLA cross-correlation search for best alignment
      let bestK = 0
      if (this._hasDoneOutput) {
        let bestCorr = -Infinity
        let prevCorr = -Infinity
        const minK = Math.max(-this._tolerance, -centerInBuf)
        const maxK = Math.min(this._tolerance, searchSize - centerInBuf - this._frameSize)

        // Precompute output-overlap norm (same for all candidates)
        let normOld = 0
        for (let c = 0; c < numCh; c++) {
          const old = oldChs[c]!
          for (let j = 0; j < hop; j++) {
            const ov = old[outPos + j]!
            normOld += ov * ov
          }
        }
        const sqrtNormOld = Math.sqrt(normOld)

        // Adaptive search
        const minStep = 1
        const maxStep = 16

        for (let k = minK; k <= maxK;) {
          const inp = centerInBuf + k
          let dot = 0; let normNew = 0
          for (let c = 0; c < numCh; c++) {
            const old = oldChs[c]!
            const newBuf = searchChs[c]!
            for (let j = 0; j < hop; j++) {
              const ov = old[outPos + j]!
              const nv = newBuf[inp + j]!
              dot += ov * nv
              normNew += nv * nv
            }
          }
          const corr = dot / (sqrtNormOld * Math.sqrt(normNew) || 1e-10)

          if (corr > bestCorr) { bestCorr = corr; bestK = k }

          const gradient = prevCorr !== -Infinity ? Math.abs(corr - prevCorr) : 0
          prevCorr = corr
          const step = Math.max(minStep, Math.min(maxStep, Math.floor(maxStep * Math.exp(-gradient * 3))))
          k += step
        }

        // Fine-tune around best offset
        const fineRange = 8
        for (let k = bestK - fineRange; k <= bestK + fineRange; k++) {
          if (k < minK || k > maxK) continue
          const inp = centerInBuf + k
          let dot = 0; let normNew = 0
          for (let c = 0; c < numCh; c++) {
            const old = oldChs[c]!
            const newBuf = searchChs[c]!
            for (let j = 0; j < hop; j++) {
              const ov = old[outPos + j]!
              const nv = newBuf[inp + j]!
              dot += ov * nv
              normNew += nv * nv
            }
          }
          const corr = dot / (sqrtNormOld * Math.sqrt(normNew) || 1e-10)
          if (corr > bestCorr) { bestCorr = corr; bestK = k }
        }
      }

      // Blend frame at best offset (split loop: hann cross-fade + direct copy)
      const frameStart = centerInBuf + bestK
      for (let c = 0; c < numCh; c++) {
        const src = searchChs[c]!
        const dst = oldChs[c]!
        const base = outPos
        for (let i = 0; i < hop; i++) {
          dst[base + i] = dst[base + i]! * hannInv[i]! + src[frameStart + i]! * hann[i]!
        }
        for (let i = hop; i < this._frameSize; i++) {
          dst[base + i] = src[frameStart + i]!
        }
      }

      this._hasDoneOutput = true
      this._outPos += hop
      this._outEnd = Math.max(this._outEnd, this._outPos + hop)
      this._inputConsumed += hop * this._step
      this._offset += hop * this._step
      this._removeConsumed()
    }

    if (this._outPos === 0) return null

    const out: Float32Array[] = []
    for (let c = 0; c < numCh; c++) {
      const buf = this._outBuf[c]!
      const slice = new Float32Array(blockSize)
      slice.set(buf.subarray(0, blockSize))
      out.push(slice)
      buf.copyWithin(0, blockSize, this._outEnd)
      buf.fill(0, this._outEnd - blockSize, this._outEnd)
    }
    this._outPos -= blockSize
    this._outEnd -= blockSize
    return out
  }

  _removeConsumed (): void {
    while (this._chunks.length > 0 && this._offset >= this._chunks[0]!.length) {
      this._offset -= this._chunks[0]!.length
      this._chunks.shift()
    }
  }

  process (_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    try {
      const out = outputs[0]!
      const blockSize = out[0]?.length ?? 128

      if (this._step === 1) {
        for (let c = 0; c < out.length; c++) out[c]!.fill(0)
        let written = 0
        while (written < blockSize && this._chunks.length > 0) {
          const chunk = this._chunks[0]!
          const rawPos = this._offset
          if (rawPos >= chunk.length) {
            this._offset -= chunk.length
            this._chunks.shift()
            continue
          }
          const pos = Math.floor(rawPos)
          const available = chunk.length - pos
          const n = Math.min(available, blockSize - written)
          for (let c = 0; c < out.length; c++) {
            const src = chunk.channelData[c] ?? chunk.channelData[0]
            if (src) out[c]!.set(src.subarray(pos, pos + n), written)
          }
          written += n
          this._offset += n
          if (this._offset >= chunk.length) {
            this._offset -= chunk.length
            this._chunks.shift()
          }
        }
        if (written > 0) {
          this._inputConsumed += written
          this.port.postMessage({ type: 'progress', samplesConsumed: this._inputConsumed })
        }
      } else {
        const wsolaOut = this._processWSOLA(blockSize)
        if (wsolaOut) {
          for (let c = 0; c < out.length; c++) {
            const src = wsolaOut[c] ?? wsolaOut[0]!
            out[c]!.set(src)
          }
          this.port.postMessage({ type: 'progress', samplesConsumed: this._inputConsumed })
        } else {
          for (let c = 0; c < out.length; c++) out[c]!.fill(0)
        }
      }
    } catch {}

    return true
  }
})

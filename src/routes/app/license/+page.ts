export async function load ({ fetch }) {
  const res = await fetch('/LICENSE.txt')

  return { licenseText: await res.text() }
}

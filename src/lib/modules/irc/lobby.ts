import { writable } from 'svelte/store'

import type MessageClient from '.'

export const irc = writable<Promise<MessageClient> | null>(null)

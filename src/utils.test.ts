import { describe, it, expect } from 'vitest'
import {
  generateRandomString,
  base64UrlEncode,
  formatAddedAt,
  shuffle,
  sha256,
} from './utils'

describe('generateRandomString', () => {
  it('returns a string of the requested length', () => {
    expect(generateRandomString(0)).toBe('')
    expect(generateRandomString(10)).toHaveLength(10)
    expect(generateRandomString(128)).toHaveLength(128)
  })

  it('returns only alphanumeric characters', () => {
    const result = generateRandomString(50)
    expect(result).toMatch(/^[A-Za-z0-9]+$/)
  })

  it('returns different values on multiple calls', () => {
    const a = generateRandomString(32)
    const b = generateRandomString(32)
    // Very unlikely to be equal for 32 chars
    expect(a).not.toBe(b)
  })
})

describe('base64UrlEncode', () => {
  it('encodes ArrayBuffer to base64url (no +, /, or =)', () => {
    const input = new Uint8Array([72, 101, 108, 108, 111]).buffer
    const result = base64UrlEncode(input)
    expect(result).not.toContain('+')
    expect(result).not.toContain('/')
    expect(result).not.toContain('=')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('formatAddedAt', () => {
  it('formats valid ISO date string', () => {
    expect(formatAddedAt('2024-01-15T12:00:00.000Z')).toMatch(/2024/)
    expect(formatAddedAt('2024-01-15T12:00:00.000Z')).toMatch(/Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/)
  })

  it('returns original string on invalid date', () => {
    expect(formatAddedAt('not-a-date')).toBe('not-a-date')
    expect(formatAddedAt('')).toBe('')
  })
})

describe('shuffle', () => {
  it('returns a new array without mutating the original', () => {
    const original = [1, 2, 3]
    const result = shuffle(original)
    expect(result).not.toBe(original)
    expect(original).toEqual([1, 2, 3])
  })

  it('returns an array of the same length', () => {
    const arr = [1, 2, 3, 4, 5]
    expect(shuffle(arr)).toHaveLength(arr.length)
  })

  it('contains the same elements', () => {
    const arr = [1, 2, 3]
    const result = shuffle(arr)
    expect(result.sort()).toEqual([1, 2, 3])
  })

  it('handles empty and single-element arrays', () => {
    expect(shuffle([])).toEqual([])
    expect(shuffle([1])).toEqual([1])
  })
})

describe('sha256', () => {
  it('returns a buffer-like value with 32 bytes when crypto.subtle is available', async () => {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
      return
    }
    const result = await sha256('hello')
    expect(result).toBeDefined()
    expect(result.byteLength).toBe(32)
  })
})

import { describe, expect, it } from 'vitest'
import { hostnameOfHostHeader, isLoopbackHost } from './loopback'

describe('isLoopbackHost', () => {
  it('accepts the loopback spellings, bracketed IPv6 included', () => {
    for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true)
    }
  })

  it('rejects everything else, including look-alikes', () => {
    for (const host of [
      '0.0.0.0',
      '192.168.1.10',
      'evil.example',
      'localhost.evil.example',
      '127.0.0.1.evil.example',
      '',
    ]) {
      expect(isLoopbackHost(host)).toBe(false)
    }
  })
})

describe('hostnameOfHostHeader', () => {
  it('strips the port and handles IPv6 literals', () => {
    expect(hostnameOfHostHeader('127.0.0.1:7788')).toBe('127.0.0.1')
    expect(hostnameOfHostHeader('localhost')).toBe('localhost')
    expect(hostnameOfHostHeader('[::1]:7788')).toBe('[::1]')
  })

  it('returns null for a missing or unparseable header', () => {
    expect(hostnameOfHostHeader(undefined)).toBeNull()
    expect(hostnameOfHostHeader('')).toBeNull()
    expect(hostnameOfHostHeader('a b c')).toBeNull()
  })
})

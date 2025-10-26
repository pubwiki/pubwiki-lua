# Storage Backend Architecture

## Overview

The pubwiki-lua state management system now supports pluggable storage backends. This allows you to customize how state data is persisted, whether using IndexedDB, LocalStorage, in-memory storage, or your own custom implementation.

## Built-in Backends

### 1. IndexedDBBackend (Default)

The default backend using IndexedDB for persistent storage across browser sessions.

```typescript
import { loadRunner, IndexedDBBackend } from 'pubwiki-lua'

// Explicitly use IndexedDB (this is the default)
const backend = new IndexedDBBackend()
await loadRunner()
```

**Features:**
- ✅ Persistent storage
- ✅ Large storage capacity (typically 50MB+)
- ✅ Structured queries
- ✅ Suitable for production use

### 2. MemoryBackend

In-memory storage for testing and development. Data is lost when the page is refreshed.

```typescript
import { loadRunner, MemoryBackend, setStorageBackend } from 'pubwiki-lua'

// Use in-memory storage (data lost on page reload)
const backend = new MemoryBackend()
setStorageBackend(backend)
await loadRunner()
```

**Features:**
- ✅ Fast performance
- ✅ No persistence (good for testing)
- ✅ No quota limits
- ✅ Synchronous operations

**Use cases:**
- Unit tests
- Development/debugging
- Temporary state that doesn't need persistence

### 3. LocalStorageBackend

Uses browser's `localStorage` for simple persistent storage.

```typescript
import { loadRunner, LocalStorageBackend, setStorageBackend } from 'pubwiki-lua'

// Use localStorage
const backend = new LocalStorageBackend()
setStorageBackend(backend)
await loadRunner()
```

**Features:**
- ✅ Simple API
- ✅ Persistent storage
- ⚠️ Limited capacity (typically 5-10MB)
- ⚠️ Synchronous API (may block UI with large data)
- ⚠️ No structured queries

**Use cases:**
- Simple applications with small state
- Compatibility with older browsers
- When IndexedDB is not available

## Custom Backend Implementation

You can implement your own storage backend by implementing the `StorageBackend` interface:

```typescript
import type { StorageBackend, StateRecord } from 'pubwiki-lua'
import { setStorageBackend, loadRunner } from 'pubwiki-lua'

class MyCustomBackend implements StorageBackend {
  private data: Map<string, StateRecord> = new Map()

  async init(): Promise<void> {
    // Initialize your storage (e.g., connect to remote database)
    console.log('Custom backend initialized')
  }

  async get(key: string): Promise<StateRecord | undefined> {
    // Retrieve a record by key
    return this.data.get(key)
  }

  async set(record: StateRecord): Promise<void> {
    // Store a record
    this.data.set(record.key, record)
  }

  async delete(key: string): Promise<void> {
    // Delete a record
    this.data.delete(key)
  }

  async getAll(): Promise<StateRecord[]> {
    // Return all records
    return Array.from(this.data.values())
  }

  async clear(): Promise<void> {
    // Clear all records
    this.data.clear()
  }

  close?(): void {
    // Optional: cleanup when done
    console.log('Custom backend closed')
  }
}

// Use your custom backend
const backend = new MyCustomBackend()
setStorageBackend(backend)
await loadRunner()
```

## Advanced Examples

### Example 1: Remote API Backend

Store state on a remote server:

```typescript
class RemoteAPIBackend implements StorageBackend {
  private apiUrl: string

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl
  }

  async init(): Promise<void> {
    // Test connection to API
    const response = await fetch(`${this.apiUrl}/health`)
    if (!response.ok) {
      throw new Error('Failed to connect to remote API')
    }
  }

  async get(key: string): Promise<StateRecord | undefined> {
    const response = await fetch(`${this.apiUrl}/state/${encodeURIComponent(key)}`)
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error('Failed to fetch state')
    return response.json()
  }

  async set(record: StateRecord): Promise<void> {
    const response = await fetch(`${this.apiUrl}/state/${encodeURIComponent(record.key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    })
    if (!response.ok) throw new Error('Failed to save state')
  }

  async delete(key: string): Promise<void> {
    const response = await fetch(`${this.apiUrl}/state/${encodeURIComponent(key)}`, {
      method: 'DELETE'
    })
    if (!response.ok) throw new Error('Failed to delete state')
  }

  async getAll(): Promise<StateRecord[]> {
    const response = await fetch(`${this.apiUrl}/state`)
    if (!response.ok) throw new Error('Failed to fetch all states')
    return response.json()
  }

  async clear(): Promise<void> {
    const response = await fetch(`${this.apiUrl}/state`, { method: 'DELETE' })
    if (!response.ok) throw new Error('Failed to clear states')
  }
}

// Usage
const backend = new RemoteAPIBackend('https://api.example.com')
setStorageBackend(backend)
await loadRunner()
```

### Example 2: Hybrid Backend (Memory + IndexedDB)

Combine in-memory cache with IndexedDB persistence:

```typescript
import { IndexedDBBackend, MemoryBackend } from 'pubwiki-lua'
import type { StorageBackend, StateRecord } from 'pubwiki-lua'

class HybridBackend implements StorageBackend {
  private memoryBackend = new MemoryBackend()
  private persistentBackend = new IndexedDBBackend()

  async init(): Promise<void> {
    await this.memoryBackend.init()
    await this.persistentBackend.init()
    
    // Pre-load all data into memory
    const allRecords = await this.persistentBackend.getAll()
    for (const record of allRecords) {
      await this.memoryBackend.set(record)
    }
  }

  async get(key: string): Promise<StateRecord | undefined> {
    // Always read from memory (fast)
    return this.memoryBackend.get(key)
  }

  async set(record: StateRecord): Promise<void> {
    // Write to both memory and IndexedDB
    await this.memoryBackend.set(record)
    await this.persistentBackend.set(record)
  }

  async delete(key: string): Promise<void> {
    await this.memoryBackend.delete(key)
    await this.persistentBackend.delete(key)
  }

  async getAll(): Promise<StateRecord[]> {
    return this.memoryBackend.getAll()
  }

  async clear(): Promise<void> {
    await this.memoryBackend.clear()
    await this.persistentBackend.clear()
  }

  close(): void {
    this.memoryBackend.close?.()
    this.persistentBackend.close?.()
  }
}

// Usage
const backend = new HybridBackend()
setStorageBackend(backend)
await loadRunner()
```

### Example 3: Encrypted Storage Backend

Encrypt data before storing in IndexedDB:

```typescript
import { IndexedDBBackend } from 'pubwiki-lua'
import type { StorageBackend, StateRecord } from 'pubwiki-lua'

class EncryptedBackend implements StorageBackend {
  private backend = new IndexedDBBackend()
  private encryptionKey: CryptoKey | null = null

  async init(): Promise<void> {
    await this.backend.init()
    
    // Generate or load encryption key
    this.encryptionKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    )
  }

  private async encrypt(data: string): Promise<string> {
    if (!this.encryptionKey) throw new Error('Encryption key not initialized')
    
    const encoder = new TextEncoder()
    const dataBuffer = encoder.encode(data)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.encryptionKey,
      dataBuffer
    )
    
    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encrypted.byteLength)
    combined.set(iv, 0)
    combined.set(new Uint8Array(encrypted), iv.length)
    
    return btoa(String.fromCharCode(...combined))
  }

  private async decrypt(encryptedData: string): Promise<string> {
    if (!this.encryptionKey) throw new Error('Encryption key not initialized')
    
    const combined = Uint8Array.from(atob(encryptedData), c => c.charCodeAt(0))
    const iv = combined.slice(0, 12)
    const data = combined.slice(12)
    
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.encryptionKey,
      data
    )
    
    const decoder = new TextDecoder()
    return decoder.decode(decrypted)
  }

  async get(key: string): Promise<StateRecord | undefined> {
    const record = await this.backend.get(key)
    if (!record) return undefined
    
    // Decrypt the value
    const decryptedValue = await this.decrypt(record.value as string)
    return {
      ...record,
      value: JSON.parse(decryptedValue)
    }
  }

  async set(record: StateRecord): Promise<void> {
    // Encrypt the value
    const encryptedValue = await this.encrypt(JSON.stringify(record.value))
    await this.backend.set({
      ...record,
      value: encryptedValue
    })
  }

  async delete(key: string): Promise<void> {
    return this.backend.delete(key)
  }

  async getAll(): Promise<StateRecord[]> {
    const records = await this.backend.getAll()
    return Promise.all(
      records.map(async record => {
        const decryptedValue = await this.decrypt(record.value as string)
        return {
          ...record,
          value: JSON.parse(decryptedValue)
        }
      })
    )
  }

  async clear(): Promise<void> {
    return this.backend.clear()
  }

  close(): void {
    this.backend.close?.()
  }
}

// Usage
const backend = new EncryptedBackend()
setStorageBackend(backend)
await loadRunner()
```

## API Reference

### StorageBackend Interface

```typescript
interface StorageBackend {
  /**
   * Initialize the storage backend
   * Called once before any other operations
   */
  init(): Promise<void>

  /**
   * Retrieve a record by key
   * @param key The unique key for the record
   * @returns The record if found, undefined otherwise
   */
  get(key: string): Promise<StateRecord | undefined>

  /**
   * Store or update a record
   * @param record The record to store
   */
  set(record: StateRecord): Promise<void>

  /**
   * Delete a record by key
   * @param key The unique key for the record
   */
  delete(key: string): Promise<void>

  /**
   * Retrieve all records
   * @returns Array of all stored records
   */
  getAll(): Promise<StateRecord[]>

  /**
   * Clear all records from storage
   */
  clear(): Promise<void>

  /**
   * Optional: Clean up resources when done
   */
  close?(): void
}
```

### StateRecord Type

```typescript
interface StateRecord {
  key: string              // Format: "scriptId:namespace:key"
  value: unknown           // The stored value (any JSON-serializable data)
  createdAt: number        // Timestamp (ms since epoch)
  updatedAt: number        // Timestamp (ms since epoch)
  expiresAt?: number       // Optional expiration timestamp
}
```

## Best Practices

### 1. Always Initialize Before Use

```typescript
// ❌ Bad: Don't call setStorageBackend after loadRunner
await loadRunner()
setStorageBackend(backend) // Error!

// ✅ Good: Set backend before loadRunner
setStorageBackend(backend)
await loadRunner()
```

### 2. Handle Errors Gracefully

```typescript
class MyBackend implements StorageBackend {
  async get(key: string): Promise<StateRecord | undefined> {
    try {
      // Your implementation
      return await this.fetchFromStorage(key)
    } catch (error) {
      console.error('Failed to get state:', error)
      return undefined // Return undefined on error
    }
  }
}
```

### 3. Implement Proper Cleanup

```typescript
class MyBackend implements StorageBackend {
  private connection: Connection | null = null

  async init(): Promise<void> {
    this.connection = await openConnection()
  }

  close(): void {
    this.connection?.close()
    this.connection = null
  }
}
```

### 4. Consider Performance

- **Memory Backend**: Fastest, but no persistence
- **LocalStorage**: Synchronous, but limited capacity
- **IndexedDB**: Asynchronous, large capacity, best for production
- **Remote API**: Network latency, consider caching

## Testing Your Backend

```typescript
import { describe, it, expect } from 'vitest'
import { MyCustomBackend } from './my-backend'

describe('MyCustomBackend', () => {
  it('should store and retrieve records', async () => {
    const backend = new MyCustomBackend()
    await backend.init()

    const record = {
      key: 'test:default:foo',
      value: 'bar',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    await backend.set(record)
    const retrieved = await backend.get(record.key)
    
    expect(retrieved).toEqual(record)
  })

  it('should delete records', async () => {
    const backend = new MyCustomBackend()
    await backend.init()

    const record = {
      key: 'test:default:foo',
      value: 'bar',
      createdAt: Date.now(),
      updatedAt: Date.now()
    }

    await backend.set(record)
    await backend.delete(record.key)
    const retrieved = await backend.get(record.key)
    
    expect(retrieved).toBeUndefined()
  })

  it('should clear all records', async () => {
    const backend = new MyCustomBackend()
    await backend.init()

    await backend.set({ key: 'test:default:a', value: '1', createdAt: Date.now(), updatedAt: Date.now() })
    await backend.set({ key: 'test:default:b', value: '2', createdAt: Date.now(), updatedAt: Date.now() })
    
    await backend.clear()
    const all = await backend.getAll()
    
    expect(all).toHaveLength(0)
  })
})
```

## Troubleshooting

### "Cannot set storage backend after state manager has been initialized"

**Solution:** Call `setStorageBackend()` before `loadRunner()`.

### IndexedDB quota exceeded

**Solution:** Use `cleanupExpiredState()` regularly or implement a custom backend with different storage.

### Performance issues with LocalStorage

**Solution:** Switch to IndexedDB or implement a caching layer with MemoryBackend.

### Data not persisting

**Solution:** Check if you're using MemoryBackend (which doesn't persist) or if there are errors in your custom backend's `set()` method.

## Migration Guide

### From Previous Version (Direct IndexedDB)

The old code continues to work without changes:

```typescript
// Old code (still works)
import { loadRunner } from 'pubwiki-lua'
await loadRunner() // Uses IndexedDB by default
```

### Using Custom Backend

```typescript
// New code (custom backend)
import { loadRunner, MemoryBackend, setStorageBackend } from 'pubwiki-lua'

const backend = new MemoryBackend()
setStorageBackend(backend)
await loadRunner()
```

No changes needed in your Lua scripts or state management calls.

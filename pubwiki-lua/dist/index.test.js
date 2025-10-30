import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { loadRunner, runLua, createSyncAdapter } from './index';
// 简单的内存 RDFStore 实现用于测试
class MemoryRDFStore {
    constructor() {
        this.triples = [];
    }
    insert(subject, predicate, object) {
        this.triples.push({ subject, predicate, object });
    }
    delete(subject, predicate, object) {
        this.triples = this.triples.filter(t => {
            if (t.subject !== subject || t.predicate !== predicate)
                return true;
            if (object === undefined || object === null)
                return false;
            return JSON.stringify(t.object) !== JSON.stringify(object);
        });
    }
    query(pattern) {
        return this.triples.filter(t => {
            if (pattern.subject !== undefined && pattern.subject !== null && t.subject !== pattern.subject)
                return false;
            if (pattern.predicate !== undefined && pattern.predicate !== null && t.predicate !== pattern.predicate)
                return false;
            if (pattern.object !== undefined && pattern.object !== null && JSON.stringify(t.object) !== JSON.stringify(pattern.object))
                return false;
            return true;
        });
    }
    batchInsert(triples) {
        this.triples.push(...triples);
    }
    clear() {
        this.triples = [];
    }
}
describe('pubwiki-lua', () => {
    let store;
    let syncStore;
    beforeAll(async () => {
        // 加载 WASM 模块
        await loadRunner();
        console.log('WASM module loaded successfully');
    });
    beforeEach(() => {
        store = new MemoryRDFStore();
        syncStore = createSyncAdapter(store);
    });
    describe('Basic Lua execution', () => {
        it('should run simple Lua code', async () => {
            const result = await runLua('return 1 + 2', syncStore);
            expect(result).toContain('3');
        });
        it('should handle print statements', async () => {
            const result = await runLua(`
        print('Hello')
        print('World')
        return 42
      `, syncStore);
            expect(result).toContain('Hello');
            expect(result).toContain('World');
            expect(result).toContain('42');
        });
    });
    describe('State.insert', () => {
        it('should insert a triple', async () => {
            await runLua(`
        State.insert('book:1984', 'title', '1984')
      `, syncStore);
            const results = store.query({ predicate: 'title' });
            expect(results).toHaveLength(1);
            expect(results[0].subject).toBe('book:1984');
            expect(results[0].object).toBe('1984');
        });
        it('should insert multiple triples', async () => {
            await runLua(`
        State.insert('book:1984', 'title', '1984')
        State.insert('book:1984', 'author', 'George Orwell')
        State.insert('book:1984', 'year', 1949)
      `, syncStore);
            const results = store.query({ subject: 'book:1984' });
            expect(results).toHaveLength(3);
        });
    });
    describe('State.query', () => {
        it('should query by subject', async () => {
            await runLua(`
        State.insert('book:1984', 'title', '1984')
        State.insert('book:1984', 'author', 'George Orwell')
        State.insert('book:brave', 'title', 'Brave New World')
      `, syncStore);
            const result = await runLua(`
        local results = State.query({subject = 'book:1984'})
        return #results
      `, syncStore);
            expect(result).toContain('2');
        });
        it('should query by predicate', async () => {
            await runLua(`
        State.insert('book:1984', 'title', '1984')
        State.insert('book:brave', 'title', 'Brave New World')
      `, syncStore);
            const result = await runLua(`
        local results = State.query({predicate = 'title'})
        return #results
      `, syncStore);
            expect(result).toContain('2');
        });
        it('should query by object', async () => {
            await runLua(`
        State.insert('book:1984', 'genre', 'dystopian')
        State.insert('book:brave', 'genre', 'dystopian')
        State.insert('book:lotr', 'genre', 'fantasy')
      `, syncStore);
            const result = await runLua(`
        local results = State.query({object = 'dystopian'})
        return #results
      `, syncStore);
            expect(result).toContain('2');
        });
    });
    describe('State.delete', () => {
        it('should delete a specific triple', async () => {
            await runLua(`
        State.insert('user:alice', 'age', 25)
        State.delete('user:alice', 'age', 25)
      `, syncStore);
            const results = store.query({ subject: 'user:alice' });
            expect(results).toHaveLength(0);
        });
        it('should delete all triples with subject+predicate', async () => {
            await runLua(`
        State.insert('user:alice', 'hobby', 'reading')
        State.insert('user:alice', 'hobby', 'coding')
        State.delete('user:alice', 'hobby')
      `, syncStore);
            const results = store.query({ subject: 'user:alice' });
            expect(results).toHaveLength(0);
        });
    });
    describe('State.batchInsert', () => {
        it('should insert multiple triples at once', async () => {
            await runLua(`
        local books = {
          {subject = 'book:1', predicate = 'title', object = 'Book 1'},
          {subject = 'book:2', predicate = 'title', object = 'Book 2'},
          {subject = 'book:3', predicate = 'title', object = 'Book 3'},
        }
        State.batchInsert(books)
      `, syncStore);
            const results = store.query({ predicate: 'title' });
            expect(results).toHaveLength(3);
        });
    });
    describe('State.set', () => {
        it('should replace existing value', async () => {
            await runLua(`
        State.insert('user:alice', 'age', 25)
        State.set('user:alice', 'age', 30)
      `, syncStore);
            const results = store.query({ subject: 'user:alice', predicate: 'age' });
            expect(results).toHaveLength(1);
            expect(results[0].object).toBe(30);
        });
        it('should work like insert when no previous value', async () => {
            await runLua(`
        State.set('user:alice', 'city', 'Tokyo')
      `, syncStore);
            const results = store.query({ subject: 'user:alice', predicate: 'city' });
            expect(results).toHaveLength(1);
            expect(results[0].object).toBe('Tokyo');
        });
    });
    describe('State.get', () => {
        it('should get a single value', async () => {
            await runLua(`
        State.insert('user:alice', 'name', 'Alice')
      `, syncStore);
            const result = await runLua(`
        local name = State.get('user:alice', 'name')
        return name
      `, syncStore);
            expect(result).toContain('Alice');
        });
        it('should return nil for non-existent property', async () => {
            const result = await runLua(`
        local value = State.get('user:alice', 'nonexistent')
        if value == nil then
          return 'is nil'
        else
          return 'not nil'
        end
      `, syncStore);
            expect(result).toContain('is nil');
        });
        it('should work with default values', async () => {
            const result = await runLua(`
        local city = State.get('user:alice', 'city') or 'Unknown'
        return city
      `, syncStore);
            expect(result).toContain('Unknown');
        });
    });
    describe('Complex scenarios', () => {
        it('should handle book catalog example', async () => {
            const result = await runLua(`
        -- Insert books
        State.batchInsert({
          {subject = 'book:1984', predicate = 'title', object = '1984'},
          {subject = 'book:1984', predicate = 'author', object = 'George Orwell'},
          {subject = 'book:1984', predicate = 'year', object = 1949},
          {subject = 'book:1984', predicate = 'genre', object = 'dystopian'},
          {subject = 'book:brave', predicate = 'title', object = 'Brave New World'},
          {subject = 'book:brave', predicate = 'author', object = 'Aldous Huxley'},
          {subject = 'book:brave', predicate = 'year', object = 1932},
          {subject = 'book:brave', predicate = 'genre', object = 'dystopian'},
        })
        
        -- Query dystopian books
        local dystopian = State.query({predicate = 'genre', object = 'dystopian'})
        local count = #dystopian
        
        -- Get titles
        local titles = {}
        for i, triple in ipairs(dystopian) do
          local title = State.get(triple.subject, 'title')
          table.insert(titles, title)
        end
        
        return string.format('Found %d dystopian books: %s', count, table.concat(titles, ', '))
      `, syncStore);
            expect(result).toContain('Found 2 dystopian books');
            expect(result).toContain('1984');
            expect(result).toContain('Brave New World');
        });
    });
});
//# sourceMappingURL=index.test.js.map
/**
 * Render smoke test.
 *
 * Mounts every page with react-dom/server and fails if any of them throws.
 *
 * This is NOT a substitute for opening the app: effects do not run under
 * renderToString, so nothing loads data and no interaction is exercised.
 * What it does catch is the class of breakage that takes a whole screen out
 * at once — a bad import, a circular dependency, a missing export, a crash
 * in the initial render path. Those are exactly the failures that turn a
 * page blank, and they are worth catching without a browser.
 *
 * Run: npm run verify:render
 */
import 'fake-indexeddb/auto';

// Browser globals the pages touch during their first render.
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => void memory.set(k, v),
    removeItem: (k: string) => void memory.delete(k),
  },
  configurable: true,
});
Object.defineProperty(globalThis, 'navigator', {
  value: { storage: undefined, clipboard: undefined },
  configurable: true,
});
(globalThis as { URL: typeof URL }).URL.createObjectURL = () => 'blob:stub';
(globalThis as { URL: typeof URL }).URL.revokeObjectURL = () => {};

const { renderToString } = await import('react-dom/server');
const { MemoryRouter, Routes, Route } = await import('react-router-dom');
const React = await import('react');

const pages: [string, string, string][] = [
  ['Dashboard', '../src/pages/Dashboard', '/'],
  ['Scan', '../src/pages/Scan', '/scan'],
  ['Inventory', '../src/pages/Inventory', '/inventory'],
  ['ItemDetail', '../src/pages/ItemDetail', '/inventory/abc'],
  ['PriceResearch', '../src/pages/PriceResearch', '/pricing'],
  ['CreateListings', '../src/pages/CreateListings', '/listings'],
  ['CrossPosting', '../src/pages/CrossPosting', '/crossposting'],
  ['Lots', '../src/pages/Lots', '/lots'],
  ['Sales', '../src/pages/Sales', '/sales'],
  ['CardShow', '../src/pages/CardShow', '/show'],
  ['Settings', '../src/pages/Settings', '/settings'],
];

let passed = 0;
const failures: string[] = [];

console.log('\nRendering every page:');

for (const [name, modulePath, path] of pages) {
  try {
    const mod = await import(modulePath);
    const Page = mod.default;
    if (typeof Page !== 'function') {
      throw new Error('module has no default-exported component');
    }

    const html = renderToString(
      React.createElement(
        MemoryRouter,
        { initialEntries: [path] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path, element: React.createElement(Page) })
        )
      )
    );

    if (typeof html !== 'string') throw new Error('render produced no markup');
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name.padEnd(15)} ${html.length} chars`);
  } catch (e) {
    failures.push(name);
    console.log(
      `  \x1b[31mFAIL\x1b[0m ${name}\n       ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

// The shared components too, since a break here takes several pages with it.
console.log('\nShared components:');
for (const [name, modulePath] of [
  ['CardSearch', '../src/components/CardSearch'],
  ['PhotoCapture', '../src/components/PhotoCapture'],
  ['RecordSaleDialog', '../src/components/RecordSaleDialog'],
  ['Auth', '../src/components/Auth'],
  ['Setup', '../src/components/Setup'],
] as [string, string][]) {
  try {
    const mod = await import(modulePath);
    if (typeof mod.default !== 'function') {
      throw new Error('no default-exported component');
    }
    passed++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name} imports cleanly`);
  } catch (e) {
    failures.push(name);
    console.log(
      `  \x1b[31mFAIL\x1b[0m ${name}\n       ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

console.log(`\n${'-'.repeat(58)}`);
if (failures.length === 0) {
  console.log(`\x1b[32m${passed} checks passed, 0 failed.\x1b[0m\n`);
  process.exit(0);
}
console.log(`\x1b[31m${passed} passed, ${failures.length} FAILED:\x1b[0m`);
for (const f of failures) console.log(`  - ${f}`);
console.log();
process.exit(1);

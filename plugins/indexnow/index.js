const { createHash } = require('node:crypto');
const { mkdir, readFile, readdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

const HOST = 'tools.turmdecker.com';
const KEY = '2999a017123e98758ba797722444c6c2';
const STATE = path.join('.netlify', 'indexnow-state.json');

const production = ({ constants }) => !constants.IS_LOCAL && process.env.CONTEXT === 'production';
const warn = error => console.warn(`[IndexNow] ${error.message ?? error}`);
const attribute = (tag, name) => {
  const value = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return value?.[1] ?? value?.[2] ?? value?.[3];
};

async function pages(directory) {
  const found = {};
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!['.git', '.netlify', '.codex', 'node_modules', 'plugins'].includes(entry.name)) {
          await visit(path.join(folder, entry.name));
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
      const html = await readFile(path.join(folder, entry.name), 'utf8');
      const link = [...html.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => tag)
        .find(tag => attribute(tag, 'rel')?.toLowerCase() === 'canonical');
      const href = link && attribute(link, 'href');
      if (!href) continue;
      let url;
      try { url = new URL(href); } catch { continue; }
      if (url.protocol !== 'https:' || url.host !== HOST || url.search || url.hash || url.username || url.password) continue;
      if (found[url.href]) throw new Error(`Duplicate canonical URL: ${url.href}`);
      found[url.href] = createHash('sha256').update(html).digest('hex');
    }
  }
  await visit(directory);
  return found;
}

async function saveSnapshot(cache, current) {
  await mkdir(path.dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify({ host: HOST, pages: current }));
  if (!await cache.save(STATE)) throw new Error('Could not cache the IndexNow baseline');
}

async function keyIsLive() {
  const response = await fetch(`https://${HOST}/${KEY}.txt`, { signal: AbortSignal.timeout(5000) });
  return response.ok && (await response.text()).trim() === KEY;
}

async function onPostBuild(context) {
  if (!production(context)) return;
  try {
    await writeFile(path.join(context.constants.PUBLISH_DIR, `${KEY}.txt`), KEY);
  } catch (error) { warn(error); }
}

async function onSuccess(context) {
  if (!production(context)) return;
  try {
    const current = await pages(context.constants.PUBLISH_DIR);
    if (!Object.keys(current).length) throw new Error('No canonical HTML pages found; baseline unchanged');
    const { cache } = context.utils;
    let previous;
    if (await cache.restore(STATE)) {
      try {
        const parsed = JSON.parse(await readFile(STATE, 'utf8'));
        if (parsed.host === HOST && parsed.pages && typeof parsed.pages === 'object' && !Array.isArray(parsed.pages)) {
          previous = parsed.pages;
        }
      } catch { /* Treat a damaged cache as a fresh baseline. */ }
    }
    const changed = previous && Object.keys({ ...previous, ...current })
      .filter(url => current[url] !== previous[url]).sort();
    if (changed && changed.length > 10000) throw new Error('More than 10,000 changed URLs; baseline unchanged');
    if (changed?.length === 0) return;
    if (!await keyIsLive()) throw new Error('Published key file is not reachable; baseline unchanged');
    if (changed) {
      const response = await fetch('https://api.indexnow.org/indexnow', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: changed }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 200 && response.status !== 202) {
        throw new Error(`IndexNow returned HTTP ${response.status}; baseline unchanged`);
      }
      console.info(`[IndexNow] Submitted ${changed.length} changed or removed URLs`);
    } else {
      console.info(`[IndexNow] Saved first baseline of ${Object.keys(current).length} canonical pages`);
    }
    await saveSnapshot(cache, current);
  } catch (error) { warn(error); }
}

module.exports = { onPostBuild, onSuccess };

import { loadCatalogArtifacts } from '../../../web/lib/server/release/catalog.mjs';
import { createReleaseStore } from '../../../web/lib/server/release/store.mjs';

const [databasePath, catalogPath, manifestPath] = process.argv.slice(2);
try {
  const catalog = loadCatalogArtifacts({ catalogPath, manifestPath });
  const store = createReleaseStore(databasePath, { catalog });
  process.stdout.write('owned\n');
  process.stdin.once('data', () => {
    store.close();
    process.exit(0);
  });
  process.stdin.resume();
} catch (error) {
  process.stdout.write(`failed:${error?.code ?? 'unknown'}\n`);
  process.exit(0);
}

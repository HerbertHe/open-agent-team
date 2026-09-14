import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve('src/plugins/bundled');
const destination = resolve('dist/bundled');
await mkdir(resolve('dist'), { recursive: true });
await cp(source, destination, { recursive: true, force: true });

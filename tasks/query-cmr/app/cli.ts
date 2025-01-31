import yargs from 'yargs';
import { promises as fs } from 'fs';
import path from 'path';
import DataOperation from '../../../app/models/data-operation';
import { createEncrypter, createDecrypter } from '../../../app/util/crypto';
import logger from '../../../app/util/log';
import env from '../../../app/util/env';
import { queryGranules } from './query';

interface HarmonyArgv {
  outputDir?: string;
  harmonyInput?: object;
  query?: (string | number)[];
  pageSize?: number;
  maxPages?: number;
  batchSize?: number;
}

/**
 * Builds and returns the CLI argument parser
 * @returns the CLI argument parser
 */
export function parser(): yargs.Argv<HarmonyArgv> {
  return yargs
    .usage('Usage: --output-dir <dir> --harmony-input <message> --query <query1> <query2>')
    .option('output-dir', {
      alias: 'o',
      describe: 'the directory where output files should be placed',
      type: 'string',
      demandOption: true,
    })
    .option('harmony-input', {
      alias: 'i',
      describe: 'the JSON-formatted input message from Harmony',
      type: 'string',
      coerce: JSON.parse,
      demandOption: true,
    })
    .option('query', {
      alias: 'q',
      describe: 'file locations containing the CMR query to be performed, one per message source',
      type: 'array',
      demandOption: true,
    })
    .option('page-size', {
      describe: 'the size of each page of results provided',
      type: 'number',
      default: 2000,
    })
    .option('max-pages', {
      describe: 'the maximum number of pages to provide per source',
      type: 'number',
      default: 1,
    })
    .option('batch-size', {
      alias: 'b',
      describe: 'number of granules to include in a single batch; create one catalog file per batch',
      type: 'number',
      default: 2000,
    });
}

/**
 * Entrypoint which does environment and CLI parsing.  Run `ts-node .` for usage.
 * @param args - The command line arguments to parse, absent any program name
 */
export default async function main(args: string[]): Promise<void> {
  const startTime = new Date().getTime();
  const appLogger = logger.child({ application: 'cmr-granule-locator' });
  const options = parser().parse(args);
  const encrypter = createEncrypter(env.sharedSecretKey);
  const decrypter = createDecrypter(env.sharedSecretKey);
  const operation = new DataOperation(options.harmonyInput, encrypter, decrypter);
  const timingLogger = appLogger.child({ requestId: operation.requestId });
  timingLogger.info('timing.cmr-granule-locator.start');
  await fs.mkdir(options.outputDir, { recursive: true });
  const catalogs = await queryGranules(
    operation,
    options.query as string[],
    options.pageSize,
    options.maxPages,
    options.batchSize,
  );

  const catalogFilenames = [];
  const promises = catalogs.map(async (catalog, i) => {
    const relativeFilename = `catalog${i}.json`;
    const filename = path.join(options.outputDir, relativeFilename);
    catalogFilenames.push(relativeFilename);
    await catalog.write(filename, true);
  });

  const catalogListFilename = path.join(options.outputDir, 'batch-catalogs.json');
  const catalogCountFilename = path.join(options.outputDir, 'batch-count.txt');

  await Promise.all(promises);

  await fs.writeFile(catalogListFilename, JSON.stringify(catalogFilenames));
  await fs.writeFile(catalogCountFilename, catalogFilenames.length);

  const durationMs = new Date().getTime() - startTime;
  timingLogger.info('timing.cmr-granule-locator.end', { durationMs });
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e); // eslint-disable-line no-console
    process.exit(1);
  });
}

import { pool } from '../database.js';
import { appLogger } from '../logger.js';
import { buildFinalTable } from './importWikimedia.js';

const logger = appLogger.child({ module: 'finishWikimediaImport' });

// Re-runs only the final build phase of the Wikimedia import against the staging
// tables (wm_stage/wm_keep/wm_img/wm_sdc) that a run leaves behind when it
// crashes after staging but before/while building wikimediaPicture — skipping
// the multi-hour re-download of the geo_tags/page/image/SDC dumps.
if (import.meta.url === `file://${process.argv[1]}`) {
  buildFinalTable(Date.now())
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error(err);

      process.exit(1);
    });
}

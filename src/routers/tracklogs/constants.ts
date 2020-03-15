import path from 'path';
import config from 'config';

const tracklogsDir = config.get('dir.tracklogs');

export const TRACKLOGS_DIR = path.resolve(global.rootDir, tracklogsDir);

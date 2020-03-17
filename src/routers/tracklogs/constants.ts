import path from 'path';
import config from 'config';

const tracklogsDir = config.get('dir.tracklogs') as string;

export const TRACKLOGS_DIR = path.resolve(__dirname, tracklogsDir);

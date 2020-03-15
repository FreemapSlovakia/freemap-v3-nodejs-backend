import path from 'path';
import config from 'config';

const picturesDir = config.get('dir.pictures');

export const PICTURES_DIR = path.resolve(global.rootDir, picturesDir);

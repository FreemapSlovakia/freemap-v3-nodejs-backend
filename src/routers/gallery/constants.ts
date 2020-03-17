import path from 'path';
import config from 'config';

const picturesDir = config.get('dir.pictures') as string;

export const PICTURES_DIR = path.resolve(__dirname, picturesDir);

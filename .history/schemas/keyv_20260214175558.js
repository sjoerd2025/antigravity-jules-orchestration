import Keyv from 'keyv';
import { DB_PATH } from './sqlite.js';

const keyv = new Keyv(`sqlite://${DB_PATH}`);

keyv.on('error', err => console.error('Keyv connection error:', err));

export default keyv;
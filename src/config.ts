import dotenv from 'dotenv';

dotenv.config();

export const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
export const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
export const MONGO_URI = process.env.MONGO_URI || '';

export const GEEKHACK_BASE = 'https://geekhack.org';

export const MAX_FOLLOWS = 10;
export const MAX_WATCHES = 10;

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.87 Safari/537.36';

export const BAD_TITLES = [
  'An Error Has Occurred!',
  'Login',
  'geekhack - Index',
];

export const DEFAULT_IMAGE =
  'https://geekhack.org/Themes/Nostalgia/images/banner.png';

export const FOOTER_ICON = 'https://i.imgur.com/JEDbZSQ.png';

export const INVITE_URL = 'https://discord.com/oauth2/authorize?client_id=772690211792224256';

// Start: node --env-file-if-exists=.env api/server.mjs   (PORT defaults to 8787)
import { createServer } from 'node:http';
import { createApp } from './app.mjs';

const port = Number(process.env.PORT || 8787);
const live = process.env.TIDEPOOL_LIVE === '1';
createServer(createApp()).listen(port, () => {
  console.log(`cashflow api on :${port} contract=${process.env.CASHFLOW_CONTRACT || '(unset)'} forwarder=${process.env.FORWARDER_ACCOUNT || '(unset)'} quotes=${live ? 'LIVE' : 'dry'}`);
});

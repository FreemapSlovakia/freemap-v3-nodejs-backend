const fs = require('fs');
const axios = require('axios');
const parseSetCookie = require('set-cookie-parser');
const querystring = require('querystring');
const config = require('config');

const username = config.get('elevation.earthexplorer.username');
const password = config.get('elevation.earthexplorer.password');

class Cookies {
  constructor() {
    this.cookies = {};
  }

  setCookies(r) {
    const setCookie = r.headers['set-cookie'];
    if (setCookie) {
      parseSetCookie(setCookie).forEach(({ name, value }) => {
        this.cookies[name] = value;
      });
    }
  }

  getHeader() {
    return Object.keys(this.cookies)
      .map(name => `${name}=${this.cookies[name]}`)
      .join('; ');
  }
}

// TODO login could be re-used for some time (or until auth error detected)
module.exports = async function downloadGeoTiff(ref, dest) {
  const indexResponse = await axios.get('https://ers.cr.usgs.gov/');
  const m = indexResponse.data.match(/name="csrf_token" value="([^"]+)"/);

  const cookies = new Cookies();
  cookies.setCookies(indexResponse);

  const loginResponse = await axios.post(
    'https://ers.cr.usgs.gov/login/',
    querystring.stringify({
      username,
      password,
      csrf_token: m[1]
    }),
    {
      maxRedirects: 0,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookies.getHeader()
      },
      validateStatus: status => status === 302
    }
  );

  cookies.setCookies(loginResponse);

  const tifResponse = await axios.get(
    // far north: https://earthexplorer.usgs.gov/download/4980/GT30W060N90/GEOTIFF/EE
    `https://earthexplorer.usgs.gov/download/8360/SRTM1${ref}V3/GEOTIFF/EE`,
    {
      headers: {
        cookie: cookies.getHeader()
      },
      responseType: 'stream',
      validateStatus: status => status === 200 || status === 500
    }
  );

  tifResponse.data.pipe(fs.createWriteStream(dest));
  await new Promise((resolve, reject) => {
    tifResponse.data.on('end', () => {
      resolve();
    });
    tifResponse.data.on('error', err => {
      reject(err);
    });
  });
};

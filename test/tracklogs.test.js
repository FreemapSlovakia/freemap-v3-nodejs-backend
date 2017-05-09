const chakram = require('chakram');
const expect = chakram.expect;
const BACKEND_URL = 'http://localhost:3000'

describe('Tracklogs', function() {
  it('POST /tracklogs should return uid', function () {
    const response = chakram.post(BACKEND_URL + '/tracklogs', {data: '<gpx />'});
    return expect(response).to.have.status(201)
    .then(function (payload) {
      expect(payload.body).to.have.property('uid');
    });
  });

  it('POST /tracklogs without data should return status 400', function () {
    const response = chakram.post(BACKEND_URL + '/tracklogs', {});
    return expect(response).to.have.status(400)
  });

  it('POST /tracklogs with data size over 5MB should return status 413', function () {
    const bigGpx = '0123456789'.repeat(100 * 1000 * 6);
    const response = chakram.post(BACKEND_URL + '/tracklogs', {data: bigGpx});
    return expect(response).to.have.status(413)
  });
});
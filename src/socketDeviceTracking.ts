import net from 'net';

const server = net.createServer(connection => {
  let imei;

  connection.on('data', data => {
    const msg = data.toString();

    console.log('DATA', msg);

    const result = /^\((.{12})([AB][A-Z]\d\d)(.*).*\)$/.exec(msg);

    if (result) {
      const [, deviceId, command, args] = result;

      console.log({ deviceId, command, args });

      if (command === 'BR00') {
        // args: 200313A4842.4669N02114.1758E014.4174559353.24,00000000L00000000
        // args: 200313 (date) A (availability) 48 42.4669 N (lat) 021 14.1758 E (lon) 014.4 (speed) 174559 (time) 353.24 (orientation) , (comma) 00000000 (io_state) L (mile post) 00000000 (mile data)

        const indexes = [2, 2, 2, 1, 2, 7, 1, 3, 7, 1, 5, 2, 2, 2, 6, 8, 1, 8];

        const slices = split(
          // my device has there some comma which is in no specs I saw so far
          args.replace(/,/g, ''),
          indexes,
        );

        const [
          yy,
          mm,
          dd,
          avail,
          latd,
          latm,
          lati,
          lond,
          lonm,
          loni,
          speed,
          hh,
          nn,
          ss,
          orientation,
          ioState,
          milepost,
          mileData,
        ] = slices;

        const date = new Date(
          Number(`20${yy}`),
          Number(mm) - 1,
          Number(dd),
          Number(hh),
          Number(nn),
          Number(ss),
        );

        const lat =
          (lati === 'S' ? -1 : 1) * (Number(latd) + Number(latm) / 60);

        const lon =
          (loni === 'W' ? -1 : 1) * (Number(lond) + Number(lonm) / 60);

        console.log('GPS', {
          avail, // A - valid, V - invalid
          date,
          lat,
          lon,
          speed: Number(speed),
          orientation: Number(orientation),
        });
      }

      if (command === 'BP00') {
        imei = args.slice(0, 15);
        // args: 352672101572147HSOP4F
        // args: 352672101572147 (imei) HSOP4F

        connection.write(`${deviceId}AP01HSO`);
      }
    }
  });

  connection.on('error', error => {
    console.log('ERROR', error);
  });

  connection.on('end', () => {
    console.log('END');
  });

  connection.on('close', c => {
    console.log('CLOSE', c);
  });
});

function split(string: string, indexes: number[]) {
  const slices = [];
  let prevIndex = 0;
  let currIndex = 0;

  for (const index of indexes) {
    currIndex += index;
    slices.push(string.slice(prevIndex, currIndex));
    prevIndex = currIndex;
  }

  return slices;
}

server.listen(3030);

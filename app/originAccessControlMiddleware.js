module.exports = function originAccessControlMiddleware(req, res, next) {
  const origin = req.get('Origin');

  res.header('Access-Control-Allow-Origin', origin);
  res.header('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Accept-Language');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, HEAD, OPTIONS, PATCH');
    res.status(204).end();
  } else {
    next();
  }
};

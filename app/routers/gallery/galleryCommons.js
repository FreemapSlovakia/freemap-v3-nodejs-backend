function fromDb({ pictureId, createdAt, pathname, title, description, takenAt, lat, lon, userId, name }) {
  return {
    id: pictureId,
    createdAt: createdAt.toISOString(),
    pathname,
    title,
    description,
    takenAt: takenAt ? takenAt.toISOString() : null,
    lat,
    lon,
    user: userId && {
      id: userId,
      name,
    },
  };
}

module.exports = {
  fromDb,
  fields: 'picture.id AS pictureId, picture.createdAt, pathname, title, description, takenAt, picture.lat, picture.lon, user.id as userId, user.name',
};

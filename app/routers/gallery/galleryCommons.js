function fromDb({ pictureId, createdAt, title, description, takenAt, lat, lon, userId, name, tags }) {
  return {
    id: pictureId,
    createdAt: createdAt.toISOString(),
    title,
    description,
    takenAt: takenAt ? takenAt.toISOString() : null,
    lat,
    lon,
    user: userId && {
      id: userId,
      name,
    },
    tags: tags ? tags.split('\n') : [],
  };
}

module.exports = {
  fromDb,
  fields: 'picture.id AS pictureId, picture.createdAt, pathname, title, description, takenAt, picture.lat, picture.lon, user.id as userId, user.name'
    + ', (SELECT GROUP_CONCAT(name SEPARATOR \'\n\') FROM pictureTag WHERE pictureId = picture.id) AS tags',
};

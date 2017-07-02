function fromDb({ RecordID, created, ImagePath, Title, Description, lat, lon, nickname }) {
  return {
    id: RecordID,
    createdAt: created.toISOString(),
    path: ImagePath,
    title: Title,
    description: Description,
    lat,
    lon,
    author: nickname,
  };
}

module.exports = {
  fromDb,
  fields: 'RecordID, fm_Attachment.Created AS created, ImagePath, '
    + 'Title, Description, fm_Attachment.Lat as lat, fm_Attachment.Lon AS lon, nickname',
};

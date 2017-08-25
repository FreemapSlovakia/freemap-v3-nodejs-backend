const bayesC = 2; // # ratings...
const bayesM = 3; // ...of ranking #
const ratingExp = `(COALESCE(SUM(stars), 0) + ${bayesM} * ${bayesC}) / (COUNT(stars) + ${bayesC})`;
const ratingSubquery = `(SELECT ${ratingExp} FROM pictureRating WHERE pictureId = picture.id) AS rating`;

module.exports = {
  ratingExp,
  ratingSubquery,
};

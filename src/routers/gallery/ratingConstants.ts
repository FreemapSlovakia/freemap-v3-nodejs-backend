const bayesC = 2; // # ratings...

const bayesM = 3; // ...of ranking #

export const ratingExp = `(COALESCE(SUM(stars), 0) + ${bayesM} * ${bayesC}) / (COUNT(stars) + ${bayesC})`;

export const ratingSubquery = `(SELECT ${ratingExp} FROM pictureRating WHERE pictureId = picture.id) AS rating`;

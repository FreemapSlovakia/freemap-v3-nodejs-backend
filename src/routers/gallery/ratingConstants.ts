const bayesC = 2; // # ratings...

// The prior mean rating: the effective rating of an unrated photo collapses to
// this (COUNT(stars)=0 → bayesM*bayesC / bayesC = bayesM).
export const bayesM = 3; // ...of ranking #

export const ratingExp = `(COALESCE(SUM(stars), 0) + ${bayesM} * ${bayesC}) / (COUNT(stars) + ${bayesC})`;

export const ratingSubquery = `(SELECT ${ratingExp} FROM pictureRating WHERE pictureId = picture.id) AS rating`;

// Same Bayesian rating for Wikimedia photos (rated on our platform via
// wikimediaRating). With no ratings it collapses to the prior mean, so a
// Wikimedia photo always has an effective rating rather than a missing 0.
export const wikimediaRatingSubquery = `(SELECT ${ratingExp} FROM wikimediaRating WHERE pageId = wikimediaPicture.pageId) AS rating`;

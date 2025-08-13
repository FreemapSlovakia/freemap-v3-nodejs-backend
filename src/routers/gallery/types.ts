export type PictureRow = {
  id: number;
  pathname: string;
  userId: number;
  title: string | null;
  description: string | null;
  takenAt: Date | null;
  createdAt: Date;
  lat: number;
  lon: number;
  pano: 0 | 1;
  premium: 0 | 1;
  azimuth: number | null;
};

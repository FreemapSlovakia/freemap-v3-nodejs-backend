declare module 'uuid-base62' {
  interface UuidBase62 {
    v4: () => string;
  }

  const uuidBase62: UuidBase62;

  export default uuidBase62;
}

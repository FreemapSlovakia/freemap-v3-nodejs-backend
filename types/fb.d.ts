declare module 'fb' {
  class Facebook {
    constructor(arg: { appSecret: string });

    withAccessToken(accessToken: string): Facebook;
    api(
      path: string,
      options: { [name: string]: any },
    ): Promise<{ id: string; name: string; email: string }>;
  }

  export { Facebook };
}

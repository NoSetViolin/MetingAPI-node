declare module "@meting/core" {
  export default class Meting {
    constructor(server?: string);
    server: string;
    format(value?: boolean): this;
    cookie(value: string): this;
    song(id: string): Promise<string>;
    playlist(id: string): Promise<string>;
    url(id: string, bitrate?: number): Promise<string>;
    pic(id: string, size?: number): Promise<string>;
    lyric(id: string): Promise<string>;
  }
}

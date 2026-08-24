declare module "gh-pages" {
  export interface PublishOptions {
    message?: string;
    dotfiles?: boolean;
  }

  export function publish(
    basePath: string,
    options: PublishOptions,
    callback: (error?: Error | null) => void
  ): Promise<void> | void;
}

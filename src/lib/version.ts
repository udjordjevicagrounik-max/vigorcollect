import pkg from '../../package.json' with { type: 'json' };

// APP_VERSION is injected at image build time (git tag/sha); package.json is the fallback.
export function getAppVersion(): string {
  return process.env.APP_VERSION || pkg.version;
}

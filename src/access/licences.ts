import { config } from '../configuration.ts';

/** Whether everyone may read what a licence covers, signed in or not, when `openLicenses` are open */
export const openLicenceCheck = (openLicenses: string[]) => {
  const open = new Set(openLicenses);
  return (licenseId: string) => open.has(licenseId);
};

/** Whether everyone may read what `licenseId` covers, by the configured open licences */
export const isOpenLicence = openLicenceCheck(config.openLicenses);

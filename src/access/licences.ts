import { config } from '../configuration.ts';

const open = new Set(config.openLicenses);

/** Whether everyone may read what `licenseId` covers, signed in or not, by the configured open licences */
//export const isOpenLicence = (licenseId: string) => true;//open.has(licenseId);

export const isOpenLicence = (licenseId: string) => {
  console.log({ openLicences: [...open], licenseId });
  return open.has(licenseId);
};

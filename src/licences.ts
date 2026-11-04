import { config } from './configuration.ts';

const openLicenses = new Set(config.openLicenses);

/** Whether everyone may read what `licenseId` covers, signed in or not */
export const isOpenLicence = (licenseId: string) => openLicenses.has(licenseId);

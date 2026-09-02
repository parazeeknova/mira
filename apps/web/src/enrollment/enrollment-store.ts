// oxlint-disable no-await-in-loop
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { PythonAdminIdentityFile } from "../protocol/protocol";

const { join, resolve } = path;

export interface EnrollmentMetadata {
  color: string;
  email?: string;
  githubUsername?: string;
  linkedinId?: string;
  name: string;
  phoneNumber?: string;
  worksAt?: string;
}

export interface EnrollmentManifestIdentity {
  files: string[];
  id: string;
  metadata: EnrollmentMetadata;
}

interface EnrollmentManifest {
  identities: EnrollmentManifestIdentity[];
}

// Local enrollment store — replaces the former R2/S3 backend.
// Files are stored under `apps/data/enrollment/<id>/` with a top-level
// `manifest.json`. This keeps enrollment durable without any cloud envs.
const ENROLLMENT_ROOT = resolve(import.meta.dir, "../../../data/enrollment");
const MANIFEST_PATH = join(ENROLLMENT_ROOT, "manifest.json");

const ensureRoot = async (): Promise<void> => {
  await mkdir(ENROLLMENT_ROOT, { recursive: true });
};

const sortManifest = (manifest: EnrollmentManifest): EnrollmentManifest => ({
  identities: manifest.identities.toSorted((left, right) =>
    left.id.localeCompare(right.id)
  ),
});

export const isEnrollmentStoreConfigured = (): boolean => true;

export const readManifest = async (): Promise<EnrollmentManifest> => {
  try {
    const file = Bun.file(MANIFEST_PATH);
    if (!(await file.exists())) {
      return { identities: [] };
    }
    const text = await file.text();
    if (!text) {
      return { identities: [] };
    }
    return sortManifest(JSON.parse(text) as EnrollmentManifest);
  } catch {
    return { identities: [] };
  }
};

const writeManifest = async (manifest: EnrollmentManifest): Promise<void> => {
  await ensureRoot();
  await Bun.write(
    MANIFEST_PATH,
    JSON.stringify(sortManifest(manifest), null, 2)
  );
};

const filePathFor = (key: string): string => join(ENROLLMENT_ROOT, key);

const deleteKeys = async (keys: string[]): Promise<void> => {
  for (const key of keys) {
    const filePath = filePathFor(key);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      await Bun.write(filePath, "");
      try {
        // Bun.write with empty string truncates; remove via fs if needed
        const { unlink } = await import("node:fs/promises");
        await unlink(filePath);
      } catch {
        // ignore missing
      }
    }
  }
};

const normalizeMetadata = (
  metadata: EnrollmentMetadata
): EnrollmentMetadata => ({
  color: metadata.color,
  ...(metadata.email === undefined ? {} : { email: metadata.email }),
  ...(metadata.githubUsername === undefined
    ? {}
    : { githubUsername: metadata.githubUsername }),
  ...(metadata.linkedinId === undefined
    ? {}
    : { linkedinId: metadata.linkedinId }),
  name: metadata.name,
  ...(metadata.phoneNumber === undefined
    ? {}
    : { phoneNumber: metadata.phoneNumber }),
  ...(metadata.worksAt === undefined ? {} : { worksAt: metadata.worksAt }),
});

export const listEnrollmentIdentities = async (): Promise<
  EnrollmentManifestIdentity[]
> => {
  const manifest = await readManifest();
  return manifest.identities;
};

export const getEnrollmentIdentity = async (
  identityId: string
): Promise<EnrollmentManifestIdentity | undefined> => {
  const identities = await listEnrollmentIdentities();
  return identities.find((identity) => identity.id === identityId);
};

export const readEnrollmentIdentityFiles = (
  identity: EnrollmentManifestIdentity
): Promise<PythonAdminIdentityFile[]> =>
  Promise.all(
    identity.files.map(async (filename) => ({
      data: Buffer.from(
        await Bun.file(filePathFor(`${identity.id}/${filename}`)).arrayBuffer()
      ).toString("base64"),
      name: filename,
    }))
  );

export const upsertEnrollmentIdentity = async (
  metadata: EnrollmentMetadata & { id: string },
  files: File[]
): Promise<EnrollmentManifestIdentity[]> => {
  const manifest = await readManifest();
  const existing = manifest.identities.find(
    (identity) => identity.id === metadata.id
  );
  const nextFiles = files.map((file) => file.name);
  const staleFiles =
    existing?.files.filter((filename) => !nextFiles.includes(filename)) ?? [];

  await ensureRoot();
  await Promise.all(
    files.map(async (file) => {
      const filePath = filePathFor(`${metadata.id}/${file.name}`);
      await mkdir(join(ENROLLMENT_ROOT, metadata.id), { recursive: true });
      await Bun.write(filePath, file);
    })
  );

  await Bun.write(
    filePathFor(`${metadata.id}/metadata.json`),
    JSON.stringify(normalizeMetadata(metadata), null, 2)
  );

  if (staleFiles.length > 0) {
    await deleteKeys(
      staleFiles.map((filename) => `${metadata.id}/${filename}`)
    );
  }

  const nextIdentity: EnrollmentManifestIdentity = {
    files: nextFiles,
    id: metadata.id,
    metadata: normalizeMetadata(metadata),
  };
  const identities = manifest.identities.filter(
    (identity) => identity.id !== metadata.id
  );
  identities.push(nextIdentity);
  await writeManifest({ identities });
  return listEnrollmentIdentities();
};

export const upsertEnrollmentIdentityPayload = async (
  metadata: EnrollmentMetadata & { id: string },
  files: PythonAdminIdentityFile[]
): Promise<EnrollmentManifestIdentity[]> => {
  const manifest = await readManifest();
  const existing = manifest.identities.find(
    (identity) => identity.id === metadata.id
  );
  const nextFiles = files.map((file) => file.name);
  const staleFiles =
    existing?.files.filter((filename) => !nextFiles.includes(filename)) ?? [];

  await ensureRoot();
  await Promise.all(
    files.map(async (file) => {
      const filePath = filePathFor(`${metadata.id}/${file.name}`);
      await mkdir(join(ENROLLMENT_ROOT, metadata.id), { recursive: true });
      await Bun.write(filePath, Buffer.from(file.data, "base64"));
    })
  );

  await Bun.write(
    filePathFor(`${metadata.id}/metadata.json`),
    JSON.stringify(normalizeMetadata(metadata), null, 2)
  );

  if (staleFiles.length > 0) {
    await deleteKeys(
      staleFiles.map((filename) => `${metadata.id}/${filename}`)
    );
  }

  const identities = manifest.identities.filter(
    (identity) => identity.id !== metadata.id
  );
  identities.push({
    files: nextFiles,
    id: metadata.id,
    metadata: normalizeMetadata(metadata),
  });
  await writeManifest({ identities });
  return listEnrollmentIdentities();
};

export const updateEnrollmentIdentityMetadata = async (
  identityId: string,
  metadata: EnrollmentMetadata
): Promise<EnrollmentManifestIdentity[]> => {
  const manifest = await readManifest();
  const existing = manifest.identities.find(
    (identity) => identity.id === identityId
  );
  if (existing === undefined) {
    throw new Error(`Identity '${identityId}' was not found.`);
  }

  const normalizedMetadata = normalizeMetadata(metadata);
  await ensureRoot();
  await Bun.write(
    filePathFor(`${identityId}/metadata.json`),
    JSON.stringify(normalizedMetadata, null, 2)
  );

  const identities = manifest.identities.map((identity) =>
    identity.id === identityId
      ? {
          ...identity,
          metadata: normalizedMetadata,
        }
      : identity
  );
  await writeManifest({ identities });
  return listEnrollmentIdentities();
};

export const deleteEnrollmentIdentity = async (
  identityId: string
): Promise<EnrollmentManifestIdentity[]> => {
  const manifest = await readManifest();
  const existing = manifest.identities.find(
    (identity) => identity.id === identityId
  );
  if (existing === undefined) {
    return manifest.identities;
  }

  await deleteKeys([
    `${identityId}/metadata.json`,
    ...existing.files.map((filename) => `${identityId}/${filename}`),
  ]);
  // Remove the now-empty directory if possible
  try {
    const { rmdir } = await import("node:fs/promises");
    await rmdir(join(ENROLLMENT_ROOT, identityId));
  } catch {
    // ignore
  }

  const identities = manifest.identities.filter(
    (identity) => identity.id !== identityId
  );
  await writeManifest({ identities });
  return listEnrollmentIdentities();
};

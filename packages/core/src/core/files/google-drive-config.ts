export type GoogleDriveSharingPolicy =
  | { kind: "members-only" }
  | { kind: "domain-readable"; domain: string };

export interface GoogleDriveUploadConfig {
  credentialsFile: string;
  /** Shared Drive root or a folder within that drive. */
  folderId: string;
  sharing: GoogleDriveSharingPolicy;
}

/** No destination means uploads are disabled. This does not change bot boot config. */
export function loadGoogleDriveUploadConfig(
  env: NodeJS.ProcessEnv = process.env,
): GoogleDriveUploadConfig | undefined {
  const folderId = env.GOOGLE_CHAT_DRIVE_FOLDER_ID?.trim();
  if (!folderId) return undefined;
  const credentialsFile = required(env, "GOOGLE_CHAT_CREDENTIALS_FILE");
  const policy = required(env, "GOOGLE_CHAT_DRIVE_SHARING_POLICY");
  let sharing: GoogleDriveSharingPolicy;
  switch (policy) {
    case "members-only":
      sharing = { kind: policy };
      break;
    case "domain-readable":
      sharing = { kind: policy, domain: required(env, "GOOGLE_CHAT_DRIVE_DOMAIN") };
      break;
    default:
      throw new Error("GOOGLE_CHAT_DRIVE_SHARING_POLICY must be members-only or domain-readable");
  }
  return { credentialsFile, folderId, sharing };
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required for Drive uploads`);
  return value;
}

# Shared Drive uploads

`core/files/google-drive-upload.ts` is a standalone upload module. It is not
wired into a chat adapter yet. `GoogleDriveUploader.upload({ data, filename,
mimeType })` uploads the supplied Buffer and returns Drive's `webViewLink` only
after the configured sharing step succeeds.

## Configuration

`loadGoogleDriveUploadConfig()` reads these names, independently of bot boot:

- `GOOGLE_CHAT_CREDENTIALS_FILE`: service-account JSON key path. The account
  itself must be a member of the Shared Drive; no user impersonation is used.
- `GOOGLE_CHAT_DRIVE_FOLDER_ID`: Shared Drive root or folder ID. Unset means
  uploads are disabled; files are never sent to My Drive by default.
- `GOOGLE_CHAT_DRIVE_SHARING_POLICY`: explicitly `members-only` or
  `domain-readable`; there is no implicit policy.
- `GOOGLE_CHAT_DRIVE_DOMAIN`: required for `domain-readable`.

`members-only` adds no permission: access is inherited from the parent.
Configure the drive/folder without broader inherited sharing if only members
should have access. The create request bypasses the domain's default file
visibility. `domain-readable` additionally grants `type=domain`, `role=reader`
to the configured domain. A posted link does not itself grant access.

## Shared Drive setup

Enable the Drive API, create a Shared Drive (and optionally an output folder),
and add the service-account email as Content manager. Service accounts are
outside the Workspace domain, so the drive must permit that membership.
For domain-readable links, also permit sharing files with nonmembers. For
members-only links, add the intended recipients as drive members. Record the
root/folder ID and choose the policy in deployment config.

The module uses the existing Google auth library with the `drive` scope and
Drive API v3 `files.create` (`supportsAllDrives=true`, explicit parent), followed
by a single resumable content PUT. It adds no retry or fallback policy. Auth,
upload, and permission errors propagate unchanged, including provider details
and transport causes. If sharing fails after upload, the file remains in Drive
and the operation rejects; it does not return a misleading accessible link.

References: [files.create](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create),
[uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads),
[permissions.create](https://developers.google.com/workspace/drive/api/reference/rest/v3/permissions/create),
[sharing](https://developers.google.com/workspace/drive/api/guides/manage-sharing),
[Shared Drives](https://developers.google.com/workspace/drive/api/guides/manage-shareddrives).

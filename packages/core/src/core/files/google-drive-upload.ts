import { GoogleAuth } from "google-auth-library";
import type { GoogleDriveUploadConfig } from "./google-drive-config.js";

export type DriveRequest = Parameters<GoogleAuth["request"]>[0];

/** The authenticated Drive HTTP seam; errors pass through unchanged. */
export interface DriveRequestor {
  request<T>(options: DriveRequest): Promise<{ data: T; headers: Headers }>;
}

export interface DriveUploadFile {
  data: Buffer;
  filename: string;
  mimeType: string;
}

interface UploadedFile {
  id: string;
  webViewLink?: string;
}

/** Standalone: no Chat, Discord, or turn state is involved. */
export class GoogleDriveUploader {
  private readonly client: DriveRequestor;

  constructor(
    private readonly config: GoogleDriveUploadConfig,
    client?: DriveRequestor,
  ) {
    this.client = client ?? new GoogleAuth({
      keyFilename: config.credentialsFile,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
  }

  async upload(file: DriveUploadFile): Promise<string> {
    const query = new URLSearchParams({
      uploadType: "resumable",
      supportsAllDrives: "true",
      fields: "id,webViewLink",
      ignoreDefaultVisibility: "true",
    });
    const start = await this.client.request<void>({
      url: `https://www.googleapis.com/upload/drive/v3/files?${query}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": file.mimeType,
        "X-Upload-Content-Length": String(file.data.byteLength),
      },
      data: { name: file.filename, mimeType: file.mimeType, parents: [this.config.folderId] },
      retry: false,
    });
    const uploadUrl = start.headers.get("location");
    if (!uploadUrl) throw new Error("Drive files.create returned no Location upload URL");

    // A resumable upload also supports a single content PUT, including files over 5 MB.
    const { data: uploaded } = await this.client.request<UploadedFile>({
      url: uploadUrl,
      method: "PUT",
      headers: { "Content-Type": file.mimeType, "Content-Length": String(file.data.byteLength) },
      data: file.data,
      retry: false,
    });
    if (!uploaded.webViewLink) {
      throw new Error(`Drive upload returned no webViewLink for file ${uploaded.id}`);
    }

    if (this.config.sharing.kind === "domain-readable") {
      await this.client.request({
        url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(uploaded.id)}/permissions?supportsAllDrives=true`,
        method: "POST",
        data: { type: "domain", role: "reader", domain: this.config.sharing.domain },
        retry: false,
      });
    }
    return uploaded.webViewLink;
  }
}

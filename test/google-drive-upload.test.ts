import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GoogleDriveUploader,
  type DriveRequestor,
  type DriveRequest,
} from "../packages/core/src/core/files/google-drive-upload.js";
import {
  loadGoogleDriveUploadConfig,
  type GoogleDriveUploadConfig,
} from "../packages/core/src/core/files/google-drive-config.js";

const auth = vi.hoisted(() => ({ options: vi.fn(), request: vi.fn() }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    constructor(options: unknown) { auth.options(options); }
    request = auth.request;
  },
}));

const members: GoogleDriveUploadConfig = {
  credentialsFile: "/test/service-account.json",
  folderId: "shared-drive-folder",
  sharing: { kind: "members-only" },
};
const file = {
  filename: "résumé.pdf",
  mimeType: "application/pdf",
  data: Buffer.from([0, 255, 13, 10, 128]),
};
const uploadUrl = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=example";
const link = "https://drive.google.com/file/d/file-id/view";

function fakeDrive() {
  const responses = [
    { data: undefined, headers: new Headers({ location: uploadUrl }) },
    { data: { id: "file-id", webViewLink: link }, headers: new Headers() },
    { data: { id: "permission-id" }, headers: new Headers() },
  ];
  const request = vi.fn(async (_options: DriveRequest) => responses.shift()!);
  const client: DriveRequestor = {
    async request<T>(options: DriveRequest) {
      const response = await request(options);
      return { ...response, data: response.data as T };
    },
  };
  return { request, client };
}

beforeEach(() => vi.clearAllMocks());

describe("Shared Drive file upload", () => {
  it("creates in the configured parent with Shared Drive support, uploads exact bytes and returns the API link", async () => {
    const drive = fakeDrive();
    const uploader = new GoogleDriveUploader(members, drive.client);

    await expect(uploader.upload(file)).resolves.toBe(link);

    expect(drive.request).toHaveBeenCalledTimes(2);
    const start = drive.request.mock.calls[0]![0];
    const url = new URL(String(start.url));
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/upload/drive/v3/files");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      uploadType: "resumable",
      supportsAllDrives: "true",
      fields: "id,webViewLink",
      ignoreDefaultVisibility: "true",
    });
    expect(start).toMatchObject({
      method: "POST",
      data: { name: file.filename, mimeType: file.mimeType, parents: [members.folderId] },
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": file.mimeType,
        "X-Upload-Content-Length": "5",
      },
      retry: false,
    });
    expect(drive.request.mock.calls[1]![0]).toMatchObject({
      url: uploadUrl,
      method: "PUT",
      data: file.data,
      headers: { "Content-Type": file.mimeType, "Content-Length": "5" },
      retry: false,
    });
    expect(drive.request.mock.calls[1]![0].data).toBe(file.data);
  });

  it("uses the explicit service-account key with the Drive scope, not impersonation or ADC", async () => {
    const drive = fakeDrive();
    auth.request.mockImplementation(drive.request);

    await expect(new GoogleDriveUploader(members).upload(file)).resolves.toBe(link);

    expect(auth.options).toHaveBeenCalledWith({
      keyFilename: members.credentialsFile,
      scopes: ["https://www.googleapis.com/auth/drive"],
    });
  });

  it("adds a domain reader permission before returning a domain-readable link", async () => {
    const drive = fakeDrive();
    const uploader = new GoogleDriveUploader({
      ...members,
      sharing: { kind: "domain-readable", domain: "example.org" },
    }, drive.client);
    let finishSharing!: () => void;
    drive.request.mockImplementationOnce(async () => ({
      data: undefined, headers: new Headers({ location: uploadUrl }),
    })).mockImplementationOnce(async () => ({
      data: { id: "file/id", webViewLink: link }, headers: new Headers(),
    })).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finishSharing = resolve; });
      return { data: { id: "permission-id" }, headers: new Headers() };
    });

    const upload = uploader.upload(file);
    let settled = false;
    void upload.then(() => { settled = true; });
    await vi.waitFor(() => expect(drive.request).toHaveBeenCalledTimes(3));
    expect(settled).toBe(false);
    expect(drive.request.mock.calls[2]![0]).toMatchObject({
      url: "https://www.googleapis.com/drive/v3/files/file%2Fid/permissions?supportsAllDrives=true",
      method: "POST",
      data: { type: "domain", role: "reader", domain: "example.org" },
      retry: false,
    });
    finishSharing();
    await expect(upload).resolves.toBe(link);
  });

  it.each([0, 6 * 1024 * 1024])("uploads %i bytes without a multipart size restriction", async (size) => {
    const drive = fakeDrive();
    const data = Buffer.alloc(size);
    await new GoogleDriveUploader(members, drive.client).upload({ ...file, data });
    const content = drive.request.mock.calls[1]![0];
    expect(content.data).toBe(data);
    expect(content.headers).toMatchObject({ "Content-Length": String(size) });
  });

  it.each(["create", "content", "permission"])("preserves the original %s failure, including provider data and transport cause", async (stage) => {
    const drive = fakeDrive();
    const failure = Object.assign(new Error("Shared drive policy forbids this operation", {
      cause: Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }),
    }), { response: { status: 403, data: { error: { message: "Shared drive policy forbids this operation" } } } });
    const successfulRequests = { create: 0, content: 1, permission: 2 }[stage]!;
    const normal = drive.request.getMockImplementation()!;
    for (let i = 0; i < successfulRequests; i++) drive.request.mockImplementationOnce(normal);
    drive.request.mockRejectedValueOnce(failure);
    const uploader = new GoogleDriveUploader({
      ...members, sharing: { kind: "domain-readable", domain: "example.org" },
    }, drive.client);

    await expect(uploader.upload(file)).rejects.toBe(failure);
    expect(drive.request).toHaveBeenCalledTimes(successfulRequests + 1);
  });

  it("preserves credential failures without attempting an anonymous upload", async () => {
    const failure = Object.assign(new Error("ENOENT: no such file, open '/test/service-account.json'"), { code: "ENOENT" });
    auth.request.mockRejectedValueOnce(failure);
    await expect(new GoogleDriveUploader(members).upload(file)).rejects.toBe(failure);
    expect(auth.request).toHaveBeenCalledTimes(1);
  });

  it("reports a missing resumable upload location rather than sending the bytes elsewhere", async () => {
    const drive = fakeDrive();
    drive.request.mockResolvedValueOnce({ data: undefined, headers: new Headers() });
    await expect(new GoogleDriveUploader(members, drive.client).upload(file))
      .rejects.toThrow("Drive files.create returned no Location upload URL");
    expect(drive.request).toHaveBeenCalledTimes(1);
  });

  it("does not invent a share link when Drive omits webViewLink", async () => {
    const drive = fakeDrive();
    const normal = drive.request.getMockImplementation()!;
    drive.request.mockImplementationOnce(normal).mockResolvedValueOnce({
      data: { id: "file-id" } as { id: string; webViewLink: string }, headers: new Headers(),
    });
    await expect(new GoogleDriveUploader(members, drive.client).upload(file))
      .rejects.toThrow("Drive upload returned no webViewLink for file file-id");
  });
});

describe("standalone Drive upload config", () => {
  const env = {
    GOOGLE_CHAT_CREDENTIALS_FILE: members.credentialsFile,
    GOOGLE_CHAT_DRIVE_FOLDER_ID: members.folderId,
    GOOGLE_CHAT_DRIVE_SHARING_POLICY: "members-only",
  };

  it("is disabled when no destination is configured, without reading credentials", () => {
    expect(loadGoogleDriveUploadConfig({})).toBeUndefined();
  });

  it("loads an explicit members-only policy", () => {
    expect(loadGoogleDriveUploadConfig(env)).toEqual(members);
  });

  it("loads an explicit domain-readable policy without embedding a deployment domain", () => {
    expect(loadGoogleDriveUploadConfig({ ...env,
      GOOGLE_CHAT_DRIVE_SHARING_POLICY: "domain-readable",
      GOOGLE_CHAT_DRIVE_DOMAIN: "example.org",
    })).toEqual({ ...members, sharing: { kind: "domain-readable", domain: "example.org" } });
  });

  it.each([
    ["GOOGLE_CHAT_CREDENTIALS_FILE", undefined, "GOOGLE_CHAT_CREDENTIALS_FILE is required"],
    ["GOOGLE_CHAT_DRIVE_SHARING_POLICY", undefined, "GOOGLE_CHAT_DRIVE_SHARING_POLICY is required"],
    ["GOOGLE_CHAT_DRIVE_SHARING_POLICY", "public", "GOOGLE_CHAT_DRIVE_SHARING_POLICY must be members-only or domain-readable"],
  ])("names a bad %s without silently changing the policy", (key, value, message) => {
    expect(() => loadGoogleDriveUploadConfig({ ...env, [key]: value })).toThrow(message);
  });

  it("names the missing domain for domain-readable sharing", () => {
    expect(() => loadGoogleDriveUploadConfig({ ...env, GOOGLE_CHAT_DRIVE_SHARING_POLICY: "domain-readable" }))
      .toThrow("GOOGLE_CHAT_DRIVE_DOMAIN is required");
  });
});

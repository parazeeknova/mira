import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

describe("FaceRecord", function () {
  async function deployFixture() {
    const [deployer, submitter, other] = await ethers.getSigners();
    const FaceRecord = await ethers.getContractFactory("FaceRecord");
    const faceRecord = await FaceRecord.deploy();
    await faceRecord.waitForDeployment();
    return { faceRecord, deployer, submitter, other };
  }

  const contentHash = ethers.id("canonical-json-payload");
  const uri = "https://example.com/proof";

  describe("store", function () {
    it("stores a record and emits RecordStored", async function () {
      const { faceRecord, submitter } = await deployFixture();

      await expect(faceRecord.connect(submitter).store(contentHash, uri))
        .to.emit(faceRecord, "RecordStored")
        .withArgs(contentHash, uri, anyUint, submitter.address);

      const count = await faceRecord.recordCount();
      expect(count).to.equal(1n);
    });

    it("reverts AlreadyStored on duplicate hash", async function () {
      const { faceRecord } = await deployFixture();
      await faceRecord.store(contentHash, uri);

      await expect(faceRecord.store(contentHash, uri))
        .to.be.revertedWithCustomError(faceRecord, "AlreadyStored")
        .withArgs(contentHash);
    });

    it("reverts EmptyUri on empty uri string", async function () {
      const { faceRecord } = await deployFixture();
      await expect(faceRecord.store(contentHash, ""))
        .to.be.revertedWithCustomError(faceRecord, "EmptyUri");
    });

    it("stores distinct hashes independently", async function () {
      const { faceRecord } = await deployFixture();
      const otherHash = ethers.id("second-payload");

      await faceRecord.store(contentHash, uri);
      await faceRecord.store(otherHash, "https://example.com/second");

      expect(await faceRecord.recordCount()).to.equal(2n);
    });

    it("rejects identical content re-store from a different address", async function () {
      const { faceRecord, other } = await deployFixture();
      await faceRecord.store(contentHash, uri);

      await expect(faceRecord.connect(other).store(contentHash, uri))
        .to.be.revertedWithCustomError(faceRecord, "AlreadyStored")
        .withArgs(contentHash);
    });
  });

  describe("verify", function () {
    it("returns exists=true with stored fields", async function () {
      const { faceRecord, submitter } = await deployFixture();
      await faceRecord.connect(submitter).store(contentHash, uri);

      const [exists, storedUri, timestamp, submitterAddr] =
        await faceRecord.verify(contentHash);

      expect(exists).to.equal(true);
      expect(storedUri).to.equal(uri);
      expect(timestamp).to.be.greaterThan(0n);
      expect(submitterAddr).to.equal(submitter.address);
    });

    it("returns exists=false with zeroed fields for unknown hash", async function () {
      const { faceRecord } = await deployFixture();
      const unknownHash = ethers.id("never-stored");

      const [exists, storedUri, timestamp, submitterAddr] =
        await faceRecord.verify(unknownHash);

      expect(exists).to.equal(false);
      expect(storedUri).to.equal("");
      expect(timestamp).to.equal(0n);
      expect(submitterAddr).to.equal(ethers.ZeroAddress);
    });

    it("does not reveal a record before storage via event index", async function () {
      const { faceRecord } = await deployFixture();
      const filter = faceRecord.filters.RecordStored(contentHash);
      const events = await faceRecord.queryFilter(filter);
      expect(events).to.have.lengthOf(0);

      await faceRecord.store(contentHash, uri);
      const after = await faceRecord.queryFilter(filter);
      expect(after).to.have.lengthOf(1);
      expect(after[0]?.args["contentHash"]).to.equal(contentHash);
    });
  });

  describe("recordCount", function () {
    it("starts at zero", async function () {
      const { faceRecord } = await deployFixture();
      expect(await faceRecord.recordCount()).to.equal(0n);
    });

    it("increments only for unique hashes", async function () {
      const { faceRecord } = await deployFixture();
      await faceRecord.store(ethers.id("a"), uri);
      await faceRecord.store(ethers.id("b"), uri);
      await expect(faceRecord.store(ethers.id("a"), uri)).to.be.reverted;

      expect(await faceRecord.recordCount()).to.equal(2n);
    });
  });
});

// helper used in the withArgs assertion above
function anyUint(value: unknown): boolean {
  return typeof value === "bigint" && value >= 0n;
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title FaceRecord
 * @notice Tamper-evident on-chain registry for face-verification records.
 *         Each record is keyed by a content hash (bytes32) derived off-chain
 *         from a canonical JSON payload. Immutability is enforced: a hash
 *         can only ever be stored once.
 */
contract FaceRecord {
    struct Record {
        string uri;
        address submitter;
        uint64 timestamp;
    }

    mapping(bytes32 => Record) private _records;
    uint256 private _recordCount;

    error AlreadyStored(bytes32 contentHash);
    error EmptyUri();

    event RecordStored(
        bytes32 indexed contentHash,
        string uri,
        uint64 timestamp,
        address indexed submitter
    );

    /**
     * @notice Store an immutable record keyed by contentHash.
     * @param contentHash SHA-256 of the canonical JSON payload (bytes32).
     * @param uri         Reference URI (e.g. the matched source page URL).
     */
    function store(bytes32 contentHash, string calldata uri) external {
        if (_records[contentHash].timestamp != 0) {
            revert AlreadyStored(contentHash);
        }
        if (bytes(uri).length == 0) {
            revert EmptyUri();
        }

        _records[contentHash] = Record({
            uri: uri,
            submitter: msg.sender,
            timestamp: uint64(block.timestamp)
        });

        unchecked {
            _recordCount += 1;
        }

        emit RecordStored(
            contentHash,
            uri,
            uint64(block.timestamp),
            msg.sender
        );
    }

    /**
     * @notice Verify whether a content hash exists on-chain.
     * @return exists     True if the hash has been stored.
     * @return uri        The stored reference URI (empty if not found).
     * @return timestamp  Unix seconds of storage (0 if not found).
     * @return submitter  Address that stored the record (address(0) if not found).
     */
    function verify(bytes32 contentHash)
        external
        view
        returns (
            bool exists,
            string memory uri,
            uint64 timestamp,
            address submitter
        )
    {
        Record storage r = _records[contentHash];
        exists = r.timestamp != 0;
        return (exists, r.uri, r.timestamp, r.submitter);
    }

    /**
     * @notice Total number of records ever stored.
     */
    function recordCount() external view returns (uint256) {
        return _recordCount;
    }
}

/*
 * Copyright © 2019 Lisk Foundation
 *
 * See the LICENSE file at the top-level directory of this distribution
 * for licensing information.
 *
 * Unless otherwise agreed in a custom licensing agreement with the Lisk Foundation,
 * no part of this software, including this file, may be copied, modified,
 * propagated, or distributed except according to the terms contained in the
 * LICENSE file.
 *
 * Removal or modification of this copyright notice is prohibited.
 *
 */
const DEFAULT_MAX_RECONNECT_TRIES = 3;

const { getPeerIdFromPeerInfo } = require('../utils');
const { CustomPeerInfo, PeerList, PeerListConfig } = require('./peer_list');

class TriedList extends PeerList {
  constructor({
    peerBucketCount,
    maxReconnectTries,
    secret,
    peerBucketSize,
    peerType,
  }) {
    super({
      secret,
      peerBucketCount,
      peerBucketSize,
      peerType,
    });

    this._maxReconnectTries = maxReconnectTries
      ? maxReconnectTries
      : DEFAULT_MAX_RECONNECT_TRIES;

    this.initializePeerList(this.peerMap);
  }

  initializePeerList(peerMap) {
    // Initialize the Map with all the buckets
    for (const bucketId of [
      ...new Array(this.peerListConfig.peerBucketCount).keys(),
    ]) {
      peerMap.set(bucketId, new Map());
    }
  }

  get triedPeerConfig() {
    return {
      ...this.peerListConfig,
      maxReconnectTries: this._maxReconnectTries,
    };
  }

  // Extend to add custom TriedPeerInfo
  initPeerInfo(peerInfo) {
    return {
      peerInfo,
      numOfConnectionFailures: 0,
      dateAdded: new Date(),
    };
  }

  // Should return true if the peer is evicted due to failed connection
  failedConnectionAction(incomingPeerInfo) {
    const bucketId = this.selectBucketId(incomingPeerInfo.ipAddress);
    const bucket = this.peerMap.get(bucketId);
    const incomingPeerId = getPeerIdFromPeerInfo(incomingPeerInfo);

    if (!bucket) {
      return false;
    }
    const foundPeer = bucket.get(incomingPeerId);

    if (!foundPeer) {
      return false;
    }
    const {
      peerInfo,
      numOfConnectionFailures,
      dateAdded,
    } = foundPeer;

    if (numOfConnectionFailures + 1 >= this._maxReconnectTries) {
      bucket.delete(incomingPeerId);

      return true;
    }
    const updatedTriedPeerInfo = {
      peerInfo,
      numOfConnectionFailures: numOfConnectionFailures + 1,
      dateAdded,
    };

    bucket.set(incomingPeerId, updatedTriedPeerInfo);

    return false;
  }
}

module.exports = {
  TriedList
};

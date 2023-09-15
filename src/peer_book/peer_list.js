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
const { getPeerIdFromPeerInfo, getBucketId, PEER_TYPE } = require('../utils');

// Base peer list class is covering a basic peer list that has all the functionality to handle buckets with default eviction strategy
class PeerList {
  constructor({
    peerBucketSize,
    peerBucketCount,
    secret,
    peerType,
  }) {
    this.peerListConfig = {
      peerBucketCount,
      peerBucketSize,
      peerType,
      secret,
    };
    this.peerMap = new Map();
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

  peersList() {
    const peersListMap = [];

    for (const peerMap of [...this.peerMap.values()]) {
      for (const peer of [...peerMap.values()]) {
        peersListMap.push(peer.peerInfo);
      }
    }

    return peersListMap;
  }

  selectBucketId(ipAddress) {
    return getBucketId({
      secret: this.peerListConfig.secret,
      peerType: this.peerListConfig.peerType,
      targetAddress: ipAddress,
      bucketCount: this.peerListConfig.peerBucketCount,
    });
  }

  updatePeer(peerInfo) {
    const bucketId = this.selectBucketId(peerInfo.ipAddress);
    const bucket = this.peerMap.get(bucketId);

    if (!bucket) {
      return false;
    }
    const incomingPeerId = getPeerIdFromPeerInfo(peerInfo);
    const foundPeer = bucket.get(incomingPeerId);

    if (!foundPeer) {
      return false;
    }
    const updatedPeerInfo = {
      ...foundPeer,
      peerInfo: { ...foundPeer.peerInfo, ...peerInfo },
    };

    bucket.set(incomingPeerId, updatedPeerInfo);

    return true;
  }

  removePeer(peerInfo) {
    const bucketId = this.selectBucketId(peerInfo.ipAddress);
    const bucket = this.peerMap.get(bucketId);
    const incomingPeerId = getPeerIdFromPeerInfo(peerInfo);

    if (bucket && bucket.get(incomingPeerId)) {
      const result = bucket.delete(incomingPeerId);

      return result;
    }

    return false;
  }

  getPeer(peerInfo) {
    const bucketId = this.selectBucketId(peerInfo.ipAddress);
    const bucket = this.peerMap.get(bucketId);
    const incomingPeerId = getPeerIdFromPeerInfo(peerInfo);

    if (!bucket) {
      return undefined;
    }
    const peer = bucket.get(incomingPeerId);

    return peer ? peer.peerInfo : undefined;
  }

  initPeerInfo(peerInfo) {
    return {
      peerInfo,
      dateAdded: new Date(),
    };
  }

  // Addition of peer can also result in peer eviction if the bucket of the incoming peer is already full based on evection strategy.
  addPeer(peerInfo) {
    const bucketId = this.selectBucketId(peerInfo.ipAddress);
    const bucket = this.peerMap.get(bucketId);
    const incomingPeerId = getPeerIdFromPeerInfo(peerInfo);

    if (!bucket) {
      return {
        success: false,
        isAdded: false,
        evictedPeer: undefined,
        message: 'No matching bucket',
      };
    }

    if (bucket && bucket.get(incomingPeerId)) {
      return {
        success: false,
        isAdded: false,
        evictedPeer: undefined,
        message: 'Peer already present in bucket',
      };
    }

    const newPeer = this.initPeerInfo(peerInfo);

    if (bucket.size < this.peerListConfig.peerBucketSize) {
      bucket.set(incomingPeerId, newPeer);

      return {
        success: true,
        isAdded: true,
        evictedPeer: undefined,
        message: 'Add peer without eviction',
      };
    }

    const evictedPeer = this.evictPeerFromBucket(bucketId);
    bucket.set(incomingPeerId, newPeer);

    return {
      success: !!evictedPeer,
      isAdded: true,
      evictedPeer: evictedPeer ? evictedPeer.peerInfo : undefined,
      message: 'Add peer with possible eviction',
    };
  }

  // This action is called when a peer is disconnected
  failedConnectionAction(incomingPeerInfo) {
    const result = this.removePeer(incomingPeerInfo);

    return result;
  }

  evictPeerFromBucket(bucketId) {
    return this.evictRandomlyFromBucket(bucketId);
  }
  // If there are no peers which are old enough to be evicted based on number of days then pick a peer randomly and evict.
  evictRandomlyFromBucket(bucketId) {
    const bucket = this.peerMap.get(bucketId);
    if (!bucket) {
      return undefined;
    }

    const bucketPeerIds = Array.from(bucket.keys());
    const randomPeerIndex = Math.floor(Math.random() * bucketPeerIds.length);
    const randomPeerId = bucketPeerIds[randomPeerIndex];
    const randomPeer = bucket.get(randomPeerId);
    bucket.delete(randomPeerId);

    return randomPeer;
  }
}

module.exports = {
  PeerList
};

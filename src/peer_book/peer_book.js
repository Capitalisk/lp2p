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

const DEFAULT_NEW_BUCKET_COUNT = 128;
const DEFAULT_NEW_BUCKET_SIZE = 32;
const DEFAULT_TRIED_BUCKET_COUNT = 64;
const DEFAULT_TRIED_BUCKET_SIZE = 32;

const { PEER_TYPE } = require('../utils');
const { NewList, NewListConfig } = require('./new_list');
const { AddPeerOutcome } = require('./peer_list');
const { TriedList, TriedListConfig } = require('./tried_list');

class PeerBook {
  constructor({
    newListConfig,
    triedListConfig,
    secret,
  }) {
    this._newPeers = new NewList(
      newListConfig
        ? newListConfig
        : {
            secret,
            peerBucketCount: DEFAULT_NEW_BUCKET_COUNT,
            peerBucketSize: DEFAULT_NEW_BUCKET_SIZE,
            peerType: PEER_TYPE.NEW_PEER,
          },
    );
    this._triedPeers = new TriedList(
      triedListConfig
        ? triedListConfig
        : {
            secret,
            peerBucketCount: DEFAULT_TRIED_BUCKET_COUNT,
            peerBucketSize: DEFAULT_TRIED_BUCKET_SIZE,
            peerType: PEER_TYPE.TRIED_PEER,
          },
    );
  }

  get newPeers() {
    return this._newPeers.peersList();
  }

  get triedPeers() {
    return this._triedPeers.peersList();
  }

  getAllPeers() {
    return [...this.newPeers, ...this.triedPeers];
  }

  getPeer(peerInfo) {
    const triedPeer = this._triedPeers.getPeer(peerInfo);
    if (triedPeer) {
      return triedPeer;
    }

    return this._newPeers.getPeer(peerInfo);
  }

  updatePeer(peerInfo) {
    if (this._triedPeers.getPeer(peerInfo)) {
      return this._triedPeers.updatePeer(peerInfo);
    }

    if (this._newPeers.getPeer(peerInfo)) {
      return this._newPeers.updatePeer(peerInfo);
    }

    return false;
  }

  // It will return evicted peer in the case a peer is removed from a peer list based on eviction strategy.
  addPeer(peerInfo) {
    if (
      this._triedPeers.getPeer(peerInfo) ||
      this._newPeers.getPeer(peerInfo)
    ) {
      throw new Error('Peer already exists');
    }

    return this._newPeers.addPeer(peerInfo);
  }

  removePeer(peerInfo) {
    if (this._triedPeers.getPeer(peerInfo)) {
      return this._triedPeers.removePeer(peerInfo);
    }

    if (this._newPeers.getPeer(peerInfo)) {
      return this._newPeers.removePeer(peerInfo);
    }

    return false;
  }

  // Move a peer from newList to triedList on events like on successful connection.
  upgradePeer(peerInfo) {
    if (this._triedPeers.getPeer(peerInfo)) {
      return true;
    }

    if (this._newPeers.getPeer(peerInfo)) {
      this._newPeers.removePeer(peerInfo);
      this._triedPeers.addPeer(peerInfo);

      return true;
    }

    return false;
  }

  /**
   * Description: When a peer is downgraded for some reasons then new/triedPeers will trigger their failedConnectionAction,
   * if the peer is deleted from newList that means the peer is completely deleted from the peer lists and need to inform the calling entity by returning true.
   */
  downgradePeer(peerInfo) {
    if (this._newPeers.getPeer(peerInfo)) {
      if (this._newPeers.failedConnectionAction(peerInfo)) {
        return true;
      }
    }

    if (this._triedPeers.getPeer(peerInfo)) {
      const failed = this._triedPeers.failedConnectionAction(peerInfo);
      if (failed) {
        this.addPeer(peerInfo);
      }
    }

    return false;
  }
}

module.exports = {
  DEFAULT_NEW_BUCKET_COUNT,
  DEFAULT_NEW_BUCKET_SIZE,
  DEFAULT_TRIED_BUCKET_COUNT,
  DEFAULT_TRIED_BUCKET_SIZE,
  PeerBook,
};

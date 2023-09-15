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

const { RPCResponseAlreadySentError } = require('./errors');

class P2PRequest {
  constructor(options, scRequest) {
    this._procedure = options.procedure;
    this._data = options.data;
    this._peerId = options.id;
    this._rate = options.rate;
    this._productivity = options.productivity;
    this._scRequest = scRequest;
  }

  enforceResponseNotAlreadySent() {
    if (this._scRequest.sent) {
      throw new RPCResponseAlreadySentError(
        `A response has already been sent for the request procedure <<${
          this._procedure
        }>>`,
      );
    }
  }

  get procedure() {
    return this._procedure;
  }

  get data() {
    return this._data;
  }

  get rate() {
    return this._rate;
  }

  get productivity() {
    return { ...this._productivity };
  }

  get peerId() {
    return this._peerId;
  }

  get wasResponseSent() {
    return this._scRequest.sent;
  }

  end(responseData) {
    this.enforceResponseNotAlreadySent();
    const responsePacket = {
      data: responseData,
    };
    this._scRequest.end(responsePacket);
  }

  error(responseError) {
    this.enforceResponseNotAlreadySent();
    this._scRequest.error(responseError);
  }
}

module.exports = {
  P2PRequest
};

import * as http from 'http';
import * as https from 'https';
import * as URL from 'url';
import Job from 'models/job';
import BaseService from './base-service';

import db = require('util/db');

/**
 * Service implementation which invokes a backend over HTTP, POSTing the Harmony
 * message to its configured endpoint and conveying its response back to the caller,
 * or creating a Job to poll and listening for service updates for async services.
 *
 * @class HttpService
 * @extends {BaseService}
 */
export default class HttpService extends BaseService {
  /**
   * Calls the HTTP backend and returns a promise for its result, or a redirect to
   * a job if the result is async.
   *
   * @param {Logger} logger The logger associated with this request
   * @param {String} harmonyRoot The harmony root URL
   * @param {String} requestUrl The URL the end user invoked
   * @returns {Promise<{
   *     error: string,
   *     errorCode: number,
   *     redirect: string,
   *     stream: Stream,
   *     headers: object,
   *     onComplete: Function
   *   }>} A promise resolving to the result of the callback. See method description
   * for properties
   * @memberof HttpService
   */
  invoke(logger?, harmonyRoot?, requestUrl?): Promise<{
    error: string;
    statusCode: number;
    redirect: string;
    stream: any;
    headers: object;
    content: string;
    onComplete: Function;
  }> {
    if (this.operation.isSynchronous) {
      return this._run(logger);
    }
    return super.invoke(logger, harmonyRoot, requestUrl);
  }

  /**
   * Calls the HTTP backend and returns a promise for its result
   * @param {Logger} logger The logger associated with this request
   * @returns {Promise<{
   *     error: string,
   *     errorCode: number,
   *     redirect: string,
   *     stream: Stream,
   *     headers: object,
   *     onComplete: Function
   *   }>} A promise resolving to the result of the callback. See method description
   * for properties
   * @memberof HttpService
   */
  _run(logger): Promise<{
    error: string;
    statusCode: number;
    redirect: string;
    stream: any;
    headers: object;
    content: string;
    onComplete: Function;
  }> {
    return new Promise((resolve, reject) => {
      try {
        const body = this.operation.serialize(this.config.data_operation_version);
        const { url } = this.params;
        logger.info('Submitting HTTP backend service request', { url });
        const uri = new URL.URL(url);
        // We need to cram the string URL into a request object for Replay to work
        const requestOptions = {
          protocol: uri.protocol,
          username: uri.username,
          password: uri.password,
          host: uri.hostname,
          port: uri.port,
          path: `${uri.pathname}?${uri.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        };

        const httplib = url.startsWith('https') ? https : http;

        const request = httplib.request(requestOptions, async (res) => {
          const result: any = {
            headers: res.headers,
            statusCode: res.statusCode,
          };

          if (!this.operation.isSynchronous && res.statusCode >= 400) {
            // Asynchronous error
            const trx = await db.transaction();
            try {
              const { user, requestId } = this.operation;
              const job = await Job.byUsernameAndRequestId(trx, user, requestId);
              if (job) {
                job.fail();
                await job.save(trx);
                await trx.commit();
              }
            } catch (e) {
              logger.error(e);
              await trx.rollback();
            }
            resolve(null);
          } else if (!this.operation.isSynchronous) {
            // Asynchronous success
            resolve(null); // Success.  Further communication is via callback
          } else if (res.statusCode < 300) {
            // Synchronous success
            result.stream = res;
            resolve(result);
          } else if (res.statusCode < 400) {
            // Synchronous redirect
            result.redirect = res.headers.location;
            resolve(result);
          } else {
            // Synchronous error
            result.error = '';
            res.on('data', (chunk) => { result.error += chunk; });
            res.on('end', () => { resolve(result); });
            res.on('error', (err) => {
              result.error = err.message;
              resolve(result);
            });
          }
        });
        // post the data
        request.write(body);
        request.end();
      } catch (e) {
        reject(e);
      }
    });
  }
}

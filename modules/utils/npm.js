import url from 'url';
// import https from 'https';
import http from 'http';
import gunzip from 'gunzip-maybe';
import LRUCache from 'lru-cache';

import bufferStream from './bufferStream.js';

import scopes, { privateNpmRegistryURL, publicNpmRegistryURL } from '../../npmConfig.js';

// npm 私库地址
const npmRegistryURLPrivate = privateNpmRegistryURL;

// 公网npm地址
const npmRegistryURL = publicNpmRegistryURL;

const privateNpmRegistryURLArr = privateNpmRegistryURL.split(":");
//获取私库的端口
const privateNpmPort = privateNpmRegistryURLArr[privateNpmRegistryURLArr.length - 1];

// const agent = new https.Agent({
//   keepAlive: true
// });


const agent = new http.Agent({
  keepAlive: true
});

const oneMegabyte = 1024 * 1024;
const oneSecond = 1000;
const oneMinute = oneSecond * 60;

const cache = new LRUCache({
  max: oneMegabyte * 40,
  length: Buffer.byteLength,
  maxAge: oneSecond
});

const notFound = '';

function get(options) {
  return new Promise((accept, reject) => {
    http.get(options, accept).on('error', reject);
  });
}

function isScopedPackageName(packageName) {
  return packageName.startsWith('@');
}

function encodePackageName(packageName) {
  return isScopedPackageName(packageName)
    ? `@${encodeURIComponent(packageName.substring(1))}`
    : encodeURIComponent(packageName);
}

function getIsPrivate(packageName) {
  return scopes.some(val => (packageName.indexOf(val) !== -1));
}

async function fetchPackageInfo(packageName, log) {
  const name = encodePackageName(packageName);

  const isPrivatePage = getIsPrivate(packageName);

  let options = null;
  let infoURL = null;

  if (isPrivatePage) {
    //私库的包
    infoURL = `${npmRegistryURLPrivate}/${name}`;
  } else {
    infoURL = `${npmRegistryURL}/${name}`;
  }

  log.debug('Fetching package info for %s from %s', packageName, infoURL);
  const { hostname, pathname } = url.parse(infoURL);

  options = {
    hostname: hostname,
    path: pathname,
    headers: {
      Accept: 'application/json'
    }
  };

  if (isPrivatePage) {
    /*
    * http.Agent 主要是为 http.request, http.get 提供代理服务
    * 使用 keepAlive 代理，有效的减少了建立/销毁连接的开销
    * port 设置私库的端口，如果不设置，默认http默认使用80，https默认使用443
    *
    */
    const agentPrivate = new http.Agent({
      keepAlive: true,
      port: privateNpmPort
    });
    options.agent = agentPrivate;
  } else {
    options.agent = agent;
  }

  const res = await get(options);

  if (res.statusCode === 200) {
    return bufferStream(res).then(JSON.parse);
  }
  if (res.statusCode === 404) {
    return null;
  }
  console.log("request info======>", infoURL, res.statusCode);

  const content = (await bufferStream(res)).toString('utf-8');

  log.error(
    'Error fetching info for %s (status: %s)',
    packageName,
    res.statusCode
  );
  log.error(content);

  return null;
}

async function fetchVersionsAndTags(packageName, log) {
  const info = await fetchPackageInfo(packageName, log);
  return info && info.versions
    ? { versions: Object.keys(info.versions), tags: info['dist-tags'] }
    : null;
}

/**
 * Returns an object of available { versions, tags }.
 * Uses a cache to avoid over-fetching from the registry.
 */
export async function getVersionsAndTags(packageName, log) {
  const cacheKey = `versions-${packageName}`;
  const cacheValue = cache.get(cacheKey);

  if (cacheValue != null) {
    return cacheValue === notFound ? null : JSON.parse(cacheValue);
  }

  const value = await fetchVersionsAndTags(packageName, log);

  if (value == null) {
    cache.set(cacheKey, notFound, 5 * oneMinute);
    return null;
  }

  cache.set(cacheKey, JSON.stringify(value), oneMinute);
  return value;
}

// All the keys that sometimes appear in package info
// docs that we don't need. There are probably more.
const packageConfigExcludeKeys = [
  'browserify',
  'bugs',
  'directories',
  'engines',
  'files',
  'homepage',
  'keywords',
  'maintainers',
  'scripts'
];

function cleanPackageConfig(config) {
  return Object.keys(config).reduce((memo, key) => {
    if (!key.startsWith('_') && !packageConfigExcludeKeys.includes(key)) {
      memo[key] = config[key];
    }

    return memo;
  }, {});
}

async function fetchPackageConfig(packageName, version, log) {
  const info = await fetchPackageInfo(packageName, log);
  return info && info.versions && version in info.versions
    ? cleanPackageConfig(info.versions[version])
    : null;
}

/**
 * Returns metadata about a package, mostly the same as package.json.
 * Uses a cache to avoid over-fetching from the registry.
 */
export async function getPackageConfig(packageName, version, log) {
  const cacheKey = `config-${packageName}-${version}`;
  const cacheValue = cache.get(cacheKey);

  if (cacheValue != null) {
    return cacheValue === notFound ? null : JSON.parse(cacheValue);
  }

  const value = await fetchPackageConfig(packageName, version, log);

  if (value == null) {
    cache.set(cacheKey, notFound, 5 * oneMinute);
    return null;
  }

  cache.set(cacheKey, JSON.stringify(value), oneMinute);
  return value;
}

/**
 * Returns a stream of the tarball'd contents of the given package.
 */
export async function getPackage(packageName, version, log) {

  // const tarballName = isScopedPackageName(packageName)
  //   ? packageName.split('/')[1]
  //   : packageName;
  // const tarballURL = `${npmRegistryURL}/${packageName}/-/${tarballName}-${version}.tgz`;
  // 这里会被切割@，外网不会
  // 获取正确的包的url

  let tarballURL = null;

  const isPrivatePage = getIsPrivate(packageName);

  if (isPrivatePage) {

    tarballURL = `${npmRegistryURLPrivate}/${packageName}/-/${packageName}-${version}.tgz`;
  } else {
    const tarballName = isScopedPackageName(packageName)
      ? packageName.split('/')[1]
      : packageName;
    tarballURL = `${npmRegistryURL}/${packageName}/-/${tarballName}-${version}.tgz`;
  }

  log.debug('Fetching package for %s from %s', packageName, tarballURL);

  const { hostname, pathname } = url.parse(tarballURL);
  const options = {
    agent: agent,
    hostname: hostname,
    path: pathname
  };

  if (isPrivatePage) {
    /*
    * http.Agent 主要是为 http.request, http.get 提供代理服务
    * 使用 keepAlive 代理，有效的减少了建立/销毁连接的开销
    * port 设置私库的端口，如果不设置，默认http默认使用80，https默认使用443
    *
    */
    const agentPrivate = new http.Agent({
      keepAlive: true,
      port: privateNpmPort
    });
    options.agent = agentPrivate;
  } else {
    options.agent = agent;
  }

  const res = await get(options);

  if (res.statusCode === 200) {
    const stream = res.pipe(gunzip());
    // stream.pause();
    return stream;
  }

  if (res.statusCode === 404) {
    return null;
  }

  console.log("request info======>", tarballURL, res.statusCode);

  const content = (await bufferStream(res)).toString('utf-8');

  log.error(
    'Error fetching tarball for %s@%s (status: %s)',
    packageName,
    version,
    res.statusCode
  );
  log.error(content);

  return null;
}

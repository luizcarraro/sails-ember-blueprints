/**
 * Module dependencies
 */
const _ = require('lodash');
const util = require('util');
const pluralize = require('pluralize');

const includes      = _.includes;
const isArray       = _.isArray;
const isString      = _.isString;
const isPlainObject = _.isPlainObject;
const isObject      = _.isObject;
const isUndefined   = _.isUndefined;
const create        = _.create;
const omit          = _.omit;
const merge         = _.merge;
const camelCase     = _.camelCase;


// Parameter used for jsonp callback is constant, as far as
// blueprints are concerned (for now.)
const JSONP_CALLBACK_PARAM = 'callback';

/**
 * Utility methods used in built-in blueprint actions.
 *
 * @type {Object}
 */
module.exports = {

  /**
   * Prepare records and populated associations to be consumed by Ember's DS.RESTAdapter
   *
   * @param {Collection} model Waterline collection object (returned from parseModel)
   * @param {Array|Object} records A record or an array of records returned from a Waterline query
   * @param {Associations} associations Definition of the associations, from `req.option.associations`
   * @param {Boolean} sideload Sideload embedded records or reduce them to primary keys?
   * @return {Object} The returned structure can be consumed by DS.RESTAdapter when passed to res.json()
   */
  emberizeJSON: function ( model, records, associations, sideload ) {
    sideload = sideload || false;

    const plural = Array.isArray( records ) ? true : false;

    let documentIdentifier = plural ? pluralize( model.globalId ) : model.globalId;

    // turn id into camelCase for ember
    documentIdentifier = _.camelCase(documentIdentifier);

    const json = {};

    json[ documentIdentifier ] = plural ? [] : {};

    if ( sideload ) {
      // prepare for sideloading
      _.forEach( associations, ( assoc ) => {
        let assocName;
        if (assoc.type === 'collection') {
          assocName = pluralize(_.camelCase(sails.models[assoc.collection].globalId));
        } else {
          assocName = pluralize(_.camelCase(sails.models[assoc.model].globalId));
        }

        // initialize jsoning object
        if ( !json.hasOwnProperty( assoc.alias ) ) {
          json[ assocName ] = [];
        }
      } );
    }

    const prepareOneRecord = function ( record ) {
      // get rid of the record's prototype ( otherwise the .toJSON called in res.send would re-insert embedded records)
      record = create( {}, record.toJSON() );
      _.forEach( associations, ( assoc ) => {
        let assocName;
        if (assoc.type === 'collection') {
          assocName = pluralize(_.camelCase(sails.models[assoc.collection].globalId));
        } else {
          assocName = pluralize(_.camelCase(sails.models[assoc.model].globalId));
        }

        if ( assoc.type === 'collection' && record[ assoc.alias ] && record[ assoc.alias ].length > 0 ) {
          if ( sideload ) { json[ assocName ] = json[ assocName ].concat( record[ assoc.alias ] ); }
          record[ assoc.alias ] = _.pluck( record[ assoc.alias ], 'id' );
        }
        if ( assoc.type === 'model' && record[ assoc.alias ] ) {
          if ( sideload ) {
            json[ assocName ] = json[ assocName ].concat( record[ assoc.alias ] );
          }
          record[ assoc.alias ] = record[ assoc.alias ].id;
        }
      } );
      return record;
    };

    // many or just one?
    if ( plural ) {
      _.forEach( records, ( record ) => {
        json[ documentIdentifier ] = json[ documentIdentifier ].concat( prepareOneRecord( record ) );
      } );
    } else {
      json[ documentIdentifier ] = prepareOneRecord( records );
    }

    if ( sideload ) {
      // filter duplicates in sideloaded records
      _.forEach( json, ( array, key ) => {
        if ( !plural && key === documentIdentifier ) { return; }
        json[ key ] = _.uniq( array, ( record ) => {
          return record.id;
        } );
      } );
    }

    return json;
  },

  /**
   * Given a Waterline query, populate the appropriate/specified
   * association attributes and return it so it can be chained
   * further ( i.e. so you can .exec() it )
   *
   * @param  {Query} query         [waterline query object]
   * @param  {Request} req
   * @return {Query}
   */
  populateEach: function ( query, req ) {
    const DEFAULT_POPULATE_LIMIT = sails.config.blueprints.defaultLimit || 30;
    const _options = req.options;
    let aliasFilter = req.param( 'populate' );
    let shouldPopulate = _options.populate;

    // Convert the string representation of the filter list to an Array. We
    // need this to provide flexibility in the request param. This way both
    // list string representations are supported:
    //   /model?populate=alias1,alias2,alias3
    //   /model?populate=[alias1,alias2,alias3]
    if ( typeof aliasFilter === 'string' ) {
      aliasFilter = aliasFilter.replace( /\[|\]/g, '' );
      aliasFilter = ( aliasFilter ) ? aliasFilter.split( ',' ) : [];
    }

    return _( _options.associations ).reduce( function populateEachAssociation( query, association ) {

      // If an alias filter was provided, override the blueprint config.
      if ( aliasFilter ) {
        shouldPopulate = includes( aliasFilter, association.alias );
      }

      // Only populate associations if a population filter has been supplied
      // with the request or if `populate` is set within the blueprint config.
      // Population filters will override any value stored in the config.
      //
      // Additionally, allow an object to be specified, where the key is the
      // name of the association attribute, and value is true/false
      // (true to populate, false to not)
      if ( shouldPopulate ) {
        const populationLimit =
          _options[ 'populate_' + association.alias + '_limit' ] ||
          _options.populate_limit ||
          _options.limit ||
          DEFAULT_POPULATE_LIMIT;

        return query.populate( association.alias, {
          limit: populationLimit
        } );
      } else {
        return query;
      }
    }, query );
  },

  /**
   * Subscribe deep (associations)
   *
   * @param  {[type]} associations [description]
   * @param  {[type]} record       [description]
   * @return {[type]}              [description]
   */
  subscribeDeep: function ( req, record ) {
    _.forEach( req.options.associations, ( assoc ) => {

      // Look up identity of associated model
      const ident = assoc[ assoc.type ];
      const AssociatedModel = sails.models[ ident ];

      if ( req.options.autoWatch ) {
        AssociatedModel.watch( req );
      }

      // Subscribe to each associated model instance in a collection
      if ( assoc.type === 'collection' ) {
        _.forEach( record[ assoc.alias ], ( associatedInstance ) => {
          AssociatedModel.subscribe( req, associatedInstance );
        } );
      }
      // If there is an associated to-one model instance, subscribe to it
      else if ( assoc.type === 'model' && record[ assoc.alias ] ) {
        AssociatedModel.subscribe( req, record[ assoc.alias ] );
      }
    } );
  },

  /**
   * Parse primary key value for use in a Waterline criteria
   * (e.g. for `find`, `update`, or `destroy`)
   *
   * @param  {Request} req
   * @return {Integer|String}
   */
  parsePk: function ( req ) {

    let pk = req.options.id || ( req.options.where && req.options.where.id ) || req.param( 'id' );

    // TODO: make this smarter...
    // (e.g. look for actual primary key of model and look for it
    //  in the absence of `id`.)
    // See coercePK for reference (although be aware it is not currently in use)

    // exclude criteria on id field
    pk = isPlainObject( pk ) ? undefined : pk;
    return pk;
  },

  /**
   * Parse primary key value from parameters.
   * Throw an error if it cannot be retrieved.
   *
   * @param  {Request} req
   * @return {Integer|String}
   */
  requirePk: function ( req ) {
    const pk = module.exports.parsePk( req );

    // Validate the required `id` parameter
    if ( !pk ) {

      const err = new Error(
        'No `id` parameter provided.' +
        '(Note: even if the model\'s primary key is not named `id`- ' +
        '`id` should be used as the name of the parameter- it will be ' +
        'mapped to the proper primary key name)'
      );
      err.status = 400;
      throw err;
    }

    return pk;
  },

  /**
   * Parse `criteria` for a Waterline `find` or `update` from all
   * request parameters.
   *
   * @param  {Request} req
   * @return {Object}            the WHERE criteria object
   */
  parseCriteria: function ( req ) {

    // Allow customizable blacklist for params NOT to include as criteria.
    req.options.criteria = req.options.criteria || {};
    req.options.criteria.blacklist = req.options.criteria.blacklist || [ 'limit', 'skip', 'sort', 'populate' ];

    // Validate blacklist to provide a more helpful error msg.
    const blacklist = req.options.criteria && req.options.criteria.blacklist;
    if ( blacklist && !isArray( blacklist ) ) {
      throw new Error( 'Invalid `req.options.criteria.blacklist`. Should be an array of strings (parameter names.)' );
    }

    // Look for explicitly specified `where` parameter.
    let where = req.params.all().where;

    // If `where` parameter is a string, try to interpret it as JSON
    if ( isString( where ) ) {
      where = tryToParseJSON( where );
    }

    // If `where` has not been specified, but other unbound parameter variables
    // **ARE** specified, build the `where` option using them.
    if ( !where ) {

      // Prune params which aren't fit to be used as `where` criteria
      // to build a proper where query
      where = req.params.all();

      // Omit built-in runtime config (like query modifiers)
      where = omit( where, blacklist || [ 'limit', 'skip', 'sort' ] );

      // Omit any params w/ undefined values
      where = omit( where, ( p ) => {
        if ( isUndefined( p ) ) {return true;}
      } );

      // Transform ids[ .., ..] request
      if ( where.ids ) {
        where.id = where.ids;
        delete where.ids;
      }

      // Omit jsonp callback param (but only if jsonp is enabled)
      let jsonpOpts = req.options.jsonp && !req.isSocket;
      jsonpOpts = isObject( jsonpOpts ) ? jsonpOpts : {
        callback: JSONP_CALLBACK_PARAM
      };
      if ( jsonpOpts ) {
        where = omit( where, [ jsonpOpts.callback ] );
      }
    }

    // Merge w/ req.options.where and return
    where = merge( {}, req.options.where || {}, where ) || undefined;

    return where;
  },

  /**
   * Parse `values` for a Waterline `create` or `update` from all
   * request parameters.
   *
   * @param  {Request} req
   * @return {Object}
   */
  parseValues: function ( req, model ) {
    // Create data object (monolithic combination of all parameters)
    // Omit the blacklisted params (like JSONP callback param, etc.)

    // Allow customizable blacklist for params NOT to include as values.
    req.options.values = req.options.values || {};
    req.options.values.blacklist = req.options.values.blacklist;

    // Validate blacklist to provide a more helpful error msg.
    const blacklist = req.options.values.blacklist;
    if ( blacklist && !isArray( blacklist ) ) {
      throw new Error( 'Invalid `req.options.values.blacklist`. Should be an array of strings (parameter names.)' );
    }

    // Get values using the model identity as resource identifier
    let values = req.param( camelCase(model.globalId) ) || {};

    // Omit built-in runtime config (like query modifiers)
    values = omit( values, blacklist || [] );

    // Omit any params w/ undefined values
    values = omit( values, ( p ) => {
      if ( _.isUndefined( p ) ) {
        return true;
      }
    } );

    // Omit jsonp callback param (but only if jsonp is enabled)
    let jsonpOpts = req.options.jsonp && !req.isSocket;
    jsonpOpts = isObject( jsonpOpts ) ? jsonpOpts : {
      callback: JSONP_CALLBACK_PARAM
    };
    if ( jsonpOpts ) {
      values = omit( values, [ jsonpOpts.callback ] );
    }

    return values;
  },

  /**
   * Determine the model class to use w/ this blueprint action.
   * @param  {Request} req
   * @return {WLCollection}
   */
  parseModel: function ( req ) {

    // Ensure a model can be deduced from the request options.
    const model = req.options.model || req.options.controller;
    if ( !model ) {throw new Error( util.format( 'No "model" specified in route options.' ) );}

    const Model = req._sails.models[ model ];
    if ( !Model ) {throw new Error( util.format( 'Invalid route option, "model".\nI don\'t know about any models named: `%s`', model ) );}

    return Model;
  },

  /**
   * @param  {Request} req
   */
  parseSort: function ( req ) {
    return req.param( 'sort' ) || req.options.sort || undefined;
  },

  /**
   * @param  {Request} req
   */
  parseLimit: function ( req ) {
    const DEFAULT_LIMIT = sails.config.blueprints.defaultLimit || 30;
    let limit = req.param( 'limit' ) || ( typeof req.options.limit !== 'undefined' ? req.options.limit : DEFAULT_LIMIT );
    if ( limit ) {
      limit = +limit;
    }
    return limit;
  },

  /**
   * @param  {Request} req
   */
  parseSkip: function ( req ) {
    const DEFAULT_SKIP = 0;
    let skip = req.param( 'skip' ) || ( typeof req.options.skip !== 'undefined' ? req.options.skip : DEFAULT_SKIP );
    if ( skip ) {
      skip = +skip;
    }
    return skip;
  }
};

// TODO:
//
// Replace the following helper with the version in sails.util:

// Attempt to parse JSON
// If the parse fails, return the error object
// If JSON is falsey, return null
// (this is so that it will be ignored if not specified)
function tryToParseJSON( json ) {
  if ( !isString( json ) ) {return null;}
  try {
    return JSON.parse( json );
  } catch ( e ) {
    return e;
  }
}

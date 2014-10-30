define(function(require) {
    var module = require('modules').get('app/vmonitor');
    var _ = require('lodash');
    var inherits = require('lodash').inherits;

    function VMonitorDashboard($q, es, Notifier) {

        var self = this;
        self.sub_categories = {};
        var notify = new Notifier({
            location: 'vMonitor'
        });

        self.getCategories = function(index) {
            /*
                Retrieves a list of categories

                Returns:
                    a promise with the result being the list of categories as strings
            */
            var deferred = $q.defer();

            var body = {
                "query": {
                    "query_string": {
                        "query": "*"
                    }
                },
                "aggs": {
                    "categories": {
                        "terms": {
                            "field": "category",
                            "size": 50
                        }
                    }
                }
            }

            es.search({
                index: index,
                type: 'tick',
                body: body
            }).then(function(r) {
                aggregations = r.aggregations
                if (!aggregations) {
                    deferred.reject('Failed to retrieve aggregations')
                }
                var categories = []
                for (x in aggregations.categories.buckets) {
                    var category = aggregations.categories.buckets[x].key
                    categories.push(category)
                }
                deferred.resolve(categories);
            }).catch(function(r) {
                console.log('Error in retrieving categories')
                deferred.resolve([]);
            })
            return deferred.promise;

        }

        self.getSubCategories = function(index, category) {
            /*
                Retrieves a list of subcategories for the given category

                Returns:
                    a promise with the result being the list of subcategories as strings
            */
            var deferred = $q.defer();
            if (self.sub_categories[category]) {
                deferred.resolve(self.sub_categories[category])
                return deferred.promise
            }


            var body = {
                "query": {
                    "query_string": {
                        "query": "category:" + category
                    }
                },
                "aggs": {
                    "sub_categories": {
                        "terms": {
                            "field": "sub_category",
                            "size": 50
                        }
                    }
                }
            }

            es.search({
                index: index,
                body: body
            }).then(function(r) {
                var sub_categories = []
                aggregations = r.aggregations
                if (!aggregations) {
                    deferred.reject('Failed to retrieve aggregations')
                }
                for (x in aggregations.sub_categories.buckets) {
                    var sub_category = aggregations.sub_categories.buckets[x].key
                    sub_categories.push(sub_category)
                }
                // cache the result
                self.sub_categories[category] = sub_categories;
                deferred.resolve(sub_categories);
            }).catch(function(r) {
                console.log('Error in retrieving subcategories')
                deferred.resolve([]);
            })
            return deferred.promise;
        }

        self.buildVMonitorChartId = function(category, sub_category) {
            /*
                Builds a unique identifier for the chart
            */
            return 'vMonitor - ' + category + ' ' + sub_category
        }

        self._createVMonitorChart = function(index, category, sub_category) {
            /*
                Creates the given chart as a visualization in the kibana elasticsearch index.  They do not have an API
                for this yet, so we will just follow the pattern they have set out.
            */
            var chartId = self.buildVMonitorChartId(category, sub_category)
            var query = "category:" + category + " AND sub_category:" + sub_category
            body = {
                "title": chartId,
                "visState": JSON.stringify({
                    "type": "line",
                    "aggs": [{
                        "type": "count",
                        "schema": "metric",
                        "params": {}
                    }, {
                        "type": "date_histogram",
                        "schema": "segment",
                        "params": {
                            "field": "timestamp",
                            "interval": "hour",
                            "min_doc_count": 1,
                            "extended_bounds": {}
                        }
                    }, {
                        "type": "terms",
                        "schema": "group",
                        "params": {
                            "field": "action",
                            "size": 10,
                            "order": "desc"
                        }
                    }]
                }),
                "description": "",
                "kibanaSavedObjectMeta": {
                    "searchSourceJSON": JSON.stringify({
                        "index": "[tick-repcore-prod-]YYYY.MM.DD",
                        "query": {
                            "query_string": {
                                "query": query
                            }
                        }
                    })
                }
            }
            r = es.index({
                index: '.kibana',
                type: 'visualization',
                id: chartId,
                body: body
            }).then(function(r) {
                console.log(r);
            }).catch(function(e) {
                console.log('Error in creating visualization for chart ' + chartId)
                notify.fatal(e)
            })
            return r
        }

        self.generateVMonitorChart = function(index, category, sub_category) {
            /*
               Checks if the graph for the given category, sub_category exists.  If not, than we
               we will generate the chart

               Returns
                   A promise with the result being a list of objects that contain the category, sub_category
                   and the chartId
            */
            var chartId = self.buildVMonitorChartId(category, sub_category)
            var deferred = $q.defer();

            r = es.get({
                index: '.kibana',
                type: 'visualization',
                id: chartId
            }).then(function(r) {
                deferred.resolve({
                    category: category,
                    sub_category: sub_category,
                    chartId: chartId
                })
            }).catch(function(r) {
                self._createVMonitorChart(index, category, sub_category)
                deferred.resolve({
                    category: category,
                    sub_category: sub_category,
                    chartId: chartId
                })
            })
            return deferred.promise;
        }

        self.getVisualizationsForCategory = function(index, category) {
            /*
                Returns a list of visualization objects that we can give to kibana to render. We will first have to
                check and create the necessary charts if they don't exist yet.
            */
            var deferred = $q.defer();
            var columnWidth = 7;

            self.getSubCategories(index, category).then(function(sub_categories) {
                $q.all(_.map(sub_categories, function(sub_category) {
                    return self.generateVMonitorChart(index, category, sub_category)
                })).then(function(charts) {

                    var row = 1;
                    var column = 1;
                    var charts = _.sortBy(charts, function(chart){ return chart.sub_category.toLowerCase(); })
                    var visualizations = _.map(charts, function(chart) {
                        var visualization = {
                            "col": column,
                            "row": row,
                            "size_x": 6,
                            "size_y": 3,
                            "visId": chart.chartId
                        }
                        if (column == columnWidth) {
                            row++;
                            column = 1;
                        } else if (column == 1) {
                            column = columnWidth;
                        }
                        return visualization;

                    });

                    deferred.resolve(visualizations);
                })

            }).catch(function(error) {
                console.log("error in retrieving visualizations");
                console.log(error);
                notify.fatal(error);
            });

            return deferred.promise;

    }

}


// Used only by the savedDashboards service, usually no reason to change this
module.factory('VMonitorDashboard', function($q, es, Notifier) {
    return new VMonitorDashboard($q, es, Notifier);
});
});
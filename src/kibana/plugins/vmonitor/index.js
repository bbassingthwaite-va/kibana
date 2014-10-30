define(function(require) {
    var _ = require('lodash');
    var $ = require('jquery');
    var ConfigTemplate = require('utils/config_template');

    require('directives/config');
    require('components/courier/courier');
    require('components/config/config');
    require('components/notify/notify');
    require('components/typeahead/typeahead');
    require('components/clipboard/clipboard');


    require('plugins/vmonitor/services/vmonitor');
    require('plugins/dashboard/directives/grid');
    require('plugins/dashboard/directives/panel');
    require('plugins/dashboard/services/saved_dashboards');
    require('css!plugins/dashboard/styles/main.css');

    var app = require('modules').get('app/vmonitor', [
        'elasticsearch',
        'ngRoute',
        'kibana/courier',
        'kibana/config',
        'kibana/notify',
        'kibana/typeahead'
    ]);

    require('routes')
        .when('/vmonitor', {
            template: require('text!plugins/vmonitor/index.html'),
            resolve: {
                dash: function(savedDashboards) {
                    return savedDashboards.get();
                }
            }
        })
        .when('/vmonitor/:id', {
            template: require('text!plugins/vmonitor/index.html'),
            resolve: {
                dash: function(savedDashboards, Notifier, $route, $location, courier) {
                    return savedDashboards.get($route.current.params.id)
                        .catch(courier.redirectWhenMissing({
                            'vmonitor': '/vmonitor'
                        }));
                }
            }
        });



    function listCategories(es, index) {
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
        return es.search({
            index: index,
            type: 'tick',
            body: body
        });
    }


    function listSubCategories(es, index, category) {
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

        return es.search({
            index: index,
            body: body
        });
    }

    function buildVMonitorChartId(category, sub_category) {
        return 'vMonitor - ' + category + ' ' + sub_category
    }

    function createVMonitorGraph(es, notify, index, category, sub_category) {
        var chartId = buildVMonitorChartId(category, sub_category)
        var query = "category:" + category +" AND sub_category:" + sub_category
        body = {
           "title": chartId,
           "visState": JSON.stringify({"type":"line","aggs":[{"type":"count","schema":"metric","params":{}},{"type":"date_histogram","schema":"segment","params":{"field":"timestamp","interval":"hour","min_doc_count":1,"extended_bounds":{}}},{"type":"terms","schema":"group","params":{"field":"action","size":10,"order":"desc"}}]}),
           "description": "",
           "kibanaSavedObjectMeta": {
               "searchSourceJSON": JSON.stringify({"index":"[tick-repcore-prod-]YYYY.MM.DD","query":{"query_string":{"query":query}}})
           }
       }
        r = es.index({
            index: '.kibana',
            type: 'visualization',
            id: chartId,
            body: body
        }).then(function(r) {
            console.log(r);
        }).catch(notify.fatal)
    }

    function generateVMonitorGraphs($q, es, notify, index, category, sub_category) {

        var chartId = buildVMonitorChartId(category, sub_category)
        var deferred = $q.defer();

        r = es.get({
            index: '.kibana',
            type: 'visualization',
            id: chartId
        }).then(function(r) {
            deferred.resolve({category: category, sub_category:sub_category, chartId:chartId})

        }).catch(function(r) {
            createVMonitorGraph(es, notify, index, category, sub_category)
            deferred.resolve({category: category, sub_category:sub_category, chartId:chartId})
        })
        return deferred.promise;
    }


    app.directive('vmonitorApp', function(VMonitorDashboard, $q, es, Notifier, courier, savedVisualizations, AppState, timefilter, kbnUrl, Promise) {
        return {
            controller: function($scope, $route, $routeParams, $location, configFile) {
                var notify = new Notifier({
                    location: 'vMonitor'
                });

                $scope.isLoading = false;
                $scope.categories = [];
                $scope.sub_categories = [];
                $scope.selectedCategory = null;
                $scope.index = 'tick-repcore-prod-2014.10.30';

                VMonitorDashboard.getCategories($scope.index).then(function(categories) {
                    $scope.categories = categories
                })

//                VMonitorDashboard.getVisualizationsForCategory($scope.index, 'category').then(function(r) {
//                    console.log(r);
//                });

                $scope.toggleCategory = function(category) {
                    $scope.isLoading = true;
                    $scope.sub_categories = [];
                    if ($scope.selectedCategory === category) {
                        $scope.selectedCategory = null;
                        return
                        $scope.isLoading = false;
                    }
                    $scope.selectedCategory = category
                    VMonitorDashboard.getSubCategories($scope.index, category).then(function(sub_categories) {
                        $scope.sub_categories = sub_categories
                        $scope.isLoading = false;
                    })

                    VMonitorDashboard.getVisualizationsForCategory($scope.index, category).then(function(visualizations) {
                        $state.panels = visualizations;
                    });
                }

                var dash = $scope.dash = $route.current.locals.dash;
                $scope.$on('$destroy', dash.destroy);

                var stateDefaults = {
                    title: dash.title,
                    panels: [],
                    query: {
                        query_string: {
                            query: '*'
                        }
                    }
                };

                var $state = $scope.state = new AppState(stateDefaults);

                $scope.configTemplate = new ConfigTemplate({
                    save: require('text!plugins/dashboard/partials/save_dashboard.html'),
                    load: require('text!plugins/dashboard/partials/load_dashboard.html'),
                    share: require('text!plugins/dashboard/partials/share.html'),
                    pickVis: require('text!plugins/dashboard/partials/pick_visualization.html')
                });

                $scope.openSave = _.partial($scope.configTemplate.toggle, 'save');
                $scope.openShare = _.partial($scope.configTemplate.toggle, 'share');
                $scope.openLoad = _.partial($scope.configTemplate.toggle, 'load');
                $scope.openAdd = _.partial($scope.configTemplate.toggle, 'pickVis');
                $scope.refresh = _.bindKey(courier, 'fetch');

                timefilter.enabled = true;
                $scope.timefilter = timefilter;
                $scope.$listen(timefilter, 'update', $scope.refresh);

                courier.setRootSearchSource(dash.searchSource);

                function init() {
                    updateQueryOnRootSource();
                    $scope.$broadcast('application.load');
                }

                function updateQueryOnRootSource() {
                    if ($state.query) {
                        dash.searchSource.set('filter', {
                            query: $state.query
                        });
                    } else {
                        dash.searchSource.set('filter', null);
                    }
                }

                $scope.newDashboard = function() {
                    kbnUrl.change('/dashboard', {}, true);
                };

                $scope.filterResults = function() {
                    updateQueryOnRootSource();
                    $state.save();
                    courier.fetch();
                };

                $scope.save = function() {
                    $state.title = dash.id = dash.title;
                    $state.save();
                    dash.panelsJSON = JSON.stringify($state.panels);

                    dash.save()
                        .then(function() {
                            notify.info('Saved Dashboard as "' + dash.title + '"');
                            if (dash.id !== $routeParams.id) {
                                kbnUrl.change('/vmonitor/{{id}}', {
                                    id: dash.id
                                });
                            }
                        })
                        .catch(notify.fatal);
                };

                var pendingVis = 0;
                $scope.$on('ready:vis', function() {
                    if (pendingVis) pendingVis--;
                    if (pendingVis === 0) {
                        $state.save();
                        courier.fetch();
                    }
                });

                // listen for notifications from the grid component that changes have
                // been made, rather than watching the panels deeply
                $scope.$on('change:vis', function() {
                    $state.save();
                });

                // called by the saved-object-finder when a user clicks a vis
                $scope.addVis = function(hit) {
                    pendingVis++;
                    $state.panels.push({
                        visId: hit.id
                    });
                };

                // Setup configurable values for config directive, after objects are initialized
                $scope.opts = {
                    dashboard: dash,
                    save: $scope.save,
                    addVis: $scope.addVis,
                    shareData: function() {
                        return {
                            link: $location.absUrl(),
                            // This sucks, but seems like the cleanest way. Uhg.
                            embed: '<iframe src="' + $location.absUrl().replace('?', '?embed&') +
                                '" height="600" width="800"></iframe>'
                        };
                    }
                };

                init();
            }
        };
    });



    var apps = require('registry/apps');
    apps.register(function VMonitorAppModule() {
        return {
            id: 'vmonitor',
            name: 'vMonitor',
            order: 2
        };
    });

});
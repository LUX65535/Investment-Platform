import * as Highcharts from 'highcharts/highstock';
import accessibility from 'highcharts/modules/accessibility';
import indicators from 'highcharts/indicators/indicators';
import volumeByPrice from 'highcharts/indicators/volume-by-price';

accessibility(Highcharts);
indicators(Highcharts);
volumeByPrice(Highcharts);

export { Highcharts };
